import express, { type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../shared/errors/app-error.js';
import {
  ALLOWED_DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  type DocumentMetadata,
  type UploadInput,
} from './documents.js';

/** Raw-body parser for document uploads (no multipart dependency needed). */
export const rawDocumentBody: RequestHandler = express.raw({
  type: [...ALLOWED_DOCUMENT_TYPES],
  limit: MAX_DOCUMENT_BYTES,
});

const uploadQuery = z.object({
  type: z.string().regex(/^[A-Z_]{2,40}$/),
  filename: z.string().min(1).max(255),
});

/** Reads `?type=…&filename=…` + raw body into an UploadInput. */
export function uploadInput(req: Request): UploadInput {
  const query = uploadQuery.safeParse(req.query);
  if (!query.success) throw new ValidationError(query.error.issues);
  const data: unknown = req.body;
  return {
    documentType: query.data.type,
    filename: query.data.filename,
    contentType: req.get('content-type') ?? '',
    data: Buffer.isBuffer(data) ? data : Buffer.alloc(0),
  };
}

/** Sends a private document safely: forced download, no sniffing, no caching. */
export function sendDocument(
  res: Response,
  doc: { metadata: DocumentMetadata; data: Buffer },
): void {
  res
    .status(200)
    .set({
      'Content-Type': doc.metadata.contentType,
      'Content-Length': String(doc.data.length),
      'Content-Disposition': `attachment; filename="${doc.metadata.originalFilename.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'",
    })
    .end(doc.data);
}

export const idSchema = z.string().regex(/^[1-9]\d{0,19}$/, 'invalid id');
export const reasonSchema = z.string().trim().min(3).max(1000);
