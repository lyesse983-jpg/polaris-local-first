import { describe, expect, it } from 'vitest';
import { formatStoreImportResult } from './storeImportResult';

describe('safe import failure diagnostics', () => {
  it('identifies collection revision conflicts without exposing record identifiers', () => {
    const text = formatStoreImportResult({
      status: 'partial', importedDomains: ['chat', 'persona', 'runtime', 'space', 'document', 'asset'],
      retainedDomains: [{ domain: 'collection', stage: 'domain-commit',
        reason: 'Local data complete row is older than existing complete row: private-record-id' }]
    });
    expect(text).toContain('房间=IMPORT_RECORD_REVISION');
    expect(text).not.toContain('private-record-id');
  });
  it('reports native row limits without displaying source data or credentials', () => {
    const text = formatStoreImportResult({
      status: 'partial', importedDomains: ['chat'],
      retainedDomains: [{ domain: 'runtime', stage: 'domain-commit',
        reason: 'SQLiteBlobTooBigException: Row too big to fit into CursorWindow; private-fixture-key=do-not-display' }]
    });
    expect(text).toContain('设置=IMPORT_SQLITE_READ_LIMIT');
    expect(text).not.toContain('private-fixture-key');
    expect(text).not.toContain('do-not-display');
  });
  it('reports fixed document body counts without leaking appended private details', () => {
    const text = formatStoreImportResult({ status: 'partial', importedDomains: [], retainedDomains: [{
      domain: 'document', stage: 'domain-commit',
      reason: 'DOCUMENT_BODY_INCOMPLETE missing=1 short=2 memory=2 workspace=1 orphan=0 private-title api-secret'
    }] });
    expect(text).toContain('IMPORT_DOCUMENT_BODY（缺正文1，长度不足2；记忆2，工作区1，孤立正文0）');
    expect(text).not.toContain('private-title');
    expect(text).not.toContain('api-secret');
  });

  it('keeps native contract rejection distinct from data validation failures', () => {
    const text = formatStoreImportResult({
      status: 'partial', importedDomains: [],
      retainedDomains: [
        { domain: 'persona', stage: 'domain-commit', reason: 'LocalData SQLite 只允许仓库适配层声明的 SQL。' },
        { domain: 'collection', stage: 'domain-commit', reason: 'migration validation failed' }
      ]
    });
    expect(text).toContain('协作者=IMPORT_SQLITE_STATEMENT');
    expect(text).toContain('房间=IMPORT_VALIDATION');
  });
});
