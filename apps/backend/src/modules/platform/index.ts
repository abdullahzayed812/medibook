/** Platform infrastructure for business modules: settings, outbox, private documents. */
export { DomainEventOutbox, type DomainEvent } from './domain-events.js';
export {
  ALLOWED_DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  PrivateDocuments,
  type DocumentMetadata,
  type DocumentTable,
} from './documents.js';
export { idSchema, rawDocumentBody, reasonSchema, sendDocument, uploadInput } from './http.js';
export {
  LocalPrivateStorage,
  ProductionLocalStorageError,
  type PrivateObjectStorage,
} from './private-storage.js';
export {
  PlatformSettingsService,
  SETTING_DEFAULTS,
  SETTINGS_SCHEMA,
  settingsPatchSchema,
  type SettingKey,
  type Settings,
} from './settings.js';
