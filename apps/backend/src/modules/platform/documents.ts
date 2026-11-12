import { createHash } from 'node:crypto';
import type { SqlExecutor } from '../../infrastructure/database/database.js';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error.js';
import { randomHex } from '../../shared/security/crypto.js';
import type { PrivateObjectStorage } from './private-storage.js';

export const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type DocumentContentType = (typeof ALLOWED_DOCUMENT_TYPES)[number];
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Magic bytes: the declared content type must match the actual file content. */
const SIGNATURES: Record<DocumentContentType, number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
};

export interface DocumentTable {
  /** Fixed table/column names from this codebase (never user input). */
  readonly table:
    | 'clinic_registration_documents'
    | 'doctor_verification_documents'
    | 'ownership_transfer_documents';
  readonly parentColumn: 'registration_request_id' | 'doctor_profile_id' | 'transfer_id';
  readonly keyPrefix: 'registration' | 'doctor-verification' | 'ownership-transfer';
  readonly types: readonly string[];
}

export interface DocumentMetadata {
  readonly id: string;
  readonly documentType: string;
  readonly originalFilename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly uploadedByUserId: string;
  readonly removedAt: Date | null;
  readonly createdAt: Date;
}

interface Row {
  id: string;
  document_type: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by_user_id: string;
  removed_at: Date | null;
  created_at: Date;
  storage_key: string;
}

const toMetadata = (row: Row): DocumentMetadata => ({
  id: row.id,
  documentType: row.document_type,
  originalFilename: row.original_filename,
  contentType: row.content_type,
  sizeBytes: row.size_bytes,
  sha256: row.sha256,
  uploadedByUserId: row.uploaded_by_user_id,
  removedAt: row.removed_at,
  createdAt: row.created_at,
});

export interface UploadInput {
  readonly documentType: string;
  readonly filename: string;
  readonly contentType: string;
  readonly data: Buffer;
}

/**
 * Private document handling shared by registrations, doctor verification and ownership
 * transfers. Callers authorize access to the PARENT first; this class only ever addresses a
 * document through (parent id, document id), so a manipulated document id of another parent
 * is "not found". Storage keys are internal and never returned to clients.
 */
export class PrivateDocuments {
  constructor(
    private readonly storage: PrivateObjectStorage,
    private readonly spec: DocumentTable,
  ) {}

  validate(input: UploadInput): DocumentContentType {
    if (!this.spec.types.includes(input.documentType)) {
      throw new ValidationError([
        { location: 'query', path: 'type', message: 'Unsupported document type' },
      ]);
    }
    const contentType = input.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!(ALLOWED_DOCUMENT_TYPES as readonly string[]).includes(contentType)) {
      throw new AppError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Only PDF, JPEG and PNG documents are accepted',
      );
    }
    if (input.data.length === 0 || input.data.length > MAX_DOCUMENT_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Documents must be between 1 byte and 10 MB');
    }
    const signature = SIGNATURES[contentType as DocumentContentType];
    if (!signature.every((byte, i) => input.data[i] === byte)) {
      throw new AppError(415, 'CONTENT_MISMATCH', 'File content does not match the declared type');
    }
    return contentType as DocumentContentType;
  }

  /** Stores the object first (random key), then the metadata row inside the caller's transaction. */
  async upload(
    tx: SqlExecutor,
    parentId: string,
    uploaderId: string,
    input: UploadInput,
  ): Promise<DocumentMetadata> {
    const contentType = this.validate(input);
    const key = `private/${this.spec.keyPrefix}/${randomHex(16)}`;
    const sha256 = createHash('sha256').update(input.data).digest('hex');
    await this.storage.put(key, input.data, contentType);
    const filename = input.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'document';
    const result = await tx.execute(
      `INSERT INTO ${this.spec.table}
         (${this.spec.parentColumn}, document_type, storage_key, original_filename, content_type, size_bytes, sha256, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parentId,
        input.documentType,
        key,
        filename,
        contentType,
        input.data.length,
        sha256,
        uploaderId,
      ],
    );
    const doc = await this.find(tx, parentId, String(result.insertId));
    if (doc === undefined) throw new Error('Document disappeared after insert');
    return toMetadata(doc);
  }

  async list(
    executor: SqlExecutor,
    parentId: string,
    includeRemoved = false,
  ): Promise<DocumentMetadata[]> {
    const rows = await executor.query<Row>(
      `SELECT * FROM ${this.spec.table} WHERE ${this.spec.parentColumn} = ? ${includeRemoved ? '' : 'AND removed_at IS NULL'} ORDER BY id`,
      [parentId],
    );
    return rows.map(toMetadata);
  }

  async countActive(executor: SqlExecutor, parentId: string): Promise<number> {
    return (await this.list(executor, parentId)).length;
  }

  async read(
    executor: SqlExecutor,
    parentId: string,
    documentId: string,
  ): Promise<{ metadata: DocumentMetadata; data: Buffer }> {
    const row = await this.find(executor, parentId, documentId);
    if (row?.removed_at !== null) throw new NotFoundError('Document not found');
    return { metadata: toMetadata(row), data: await this.storage.get(row.storage_key) };
  }

  /** Soft removal (the object and row are kept for history). */
  async remove(
    executor: SqlExecutor,
    parentId: string,
    documentId: string,
    now: Date,
  ): Promise<void> {
    const result = await executor.execute(
      `UPDATE ${this.spec.table} SET removed_at = ? WHERE id = ? AND ${this.spec.parentColumn} = ? AND removed_at IS NULL`,
      [now, documentId, parentId],
    );
    if (result.affectedRows !== 1) throw new NotFoundError('Document not found');
  }

  private async find(
    executor: SqlExecutor,
    parentId: string,
    documentId: string,
  ): Promise<Row | undefined> {
    const rows = await executor.query<Row>(
      `SELECT * FROM ${this.spec.table} WHERE id = ? AND ${this.spec.parentColumn} = ?`,
      [documentId, parentId],
    );
    return rows[0];
  }
}
