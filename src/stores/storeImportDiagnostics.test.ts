import { describe, expect, it } from 'vitest';
import { formatStoreImportResult } from './storeImportResult';

describe('safe import failure diagnostics', () => {
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
