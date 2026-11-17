import type { LocalDataDomain } from '../engines/localData';

export type StoreImportDomainFailure = {
  domain: LocalDataDomain | 'localStorage';
  stage: 'asset-staging' | 'domain-commit' | 'promotion' | 'local-storage' | 'refresh' | 'cleanup';
  reason: string;
};

export type StoreImportResult = {
  status: 'complete' | 'partial';
  importedDomains: LocalDataDomain[];
  retainedDomains: StoreImportDomainFailure[];
};

const DOMAIN_LABELS: Record<StoreImportDomainFailure['domain'], string> = {
  chat: '对话',
  collection: '房间',
  persona: '协作者',
  runtime: '设置',
  space: '界面状态',
  asset: '附件',
  document: '文档',
  localStorage: '本地界面状态'
};

function importFailureCode(reason: string) {
  const body = /DOCUMENT_BODY_INCOMPLETE missing=(\d+) short=(\d+) memory=(\d+) workspace=(\d+) orphan=(\d+)/.exec(reason);
  if (body) return `IMPORT_DOCUMENT_BODY（缺正文${body[1]}，长度不足${body[2]}；记忆${body[3]}，工作区${body[4]}，孤立正文${body[5]}）`;
  if (/hydration preview is not validation-ready/i.test(reason)) return 'IMPORT_VALIDATION_PREVIEW';
  if (/validation (shrank|lost)/i.test(reason)) return 'IMPORT_VALIDATION_COVERAGE';
  if (/validation contains duplicate object ids/i.test(reason)) return 'IMPORT_VALIDATION_DUPLICATE';
  if (/validation contains non-complete active rows/i.test(reason)) return 'IMPORT_VALIDATION_INCOMPLETE';
  if (/complete row is older than existing complete row/i.test(reason)) return 'IMPORT_RECORD_REVISION';
  if (/same row key more than once/i.test(reason)) return 'IMPORT_DUPLICATE_RECORD';
  if (/CursorWindow|SQLiteBlobTooBigException|Row too big/i.test(reason)) return 'IMPORT_SQLITE_READ_LIMIT';
  if (/只允许仓库适配层声明的 SQL|disallowedSql/i.test(reason)) return 'IMPORT_SQLITE_STATEMENT';
  if (/validation|verify-failed|验证失败|校验失败/i.test(reason)) return 'IMPORT_VALIDATION';
  return null;
}

export function formatStoreImportResult(result: StoreImportResult) {
  if (result.status === 'complete') {
    return `导入完成：${result.importedDomains.length} 个数据域已安全替换。`;
  }
  const retained = result.retainedDomains
    .filter((entry) => entry.stage !== 'promotion' && entry.stage !== 'refresh')
    .map((entry) => DOMAIN_LABELS[entry.domain]);
  const verification = result.retainedDomains
    .filter((entry) => entry.stage === 'promotion' || entry.stage === 'refresh' || entry.stage === 'cleanup')
    .map((entry) => DOMAIN_LABELS[entry.domain]);
  const parts = [`部分导入完成：${result.importedDomains.length} 个数据域已更新。`];
  if (retained.length > 0) {
    parts.push(`${Array.from(new Set(retained)).join('、')}写入失败，已有数据没有被清空。`);
  }
  if (verification.length > 0) {
    parts.push(`${Array.from(new Set(verification)).join('、')}的激活、清理或界面刷新将在下次启动继续检查。`);
  }
  const diagnostics = result.retainedDomains.flatMap((entry) => {
    const code = importFailureCode(entry.reason);
    return code ? [DOMAIN_LABELS[entry.domain] + '=' + code] : [];
  });
  if (diagnostics.length) parts.push('诊断：' + Array.from(new Set(diagnostics)).join('；') + '。');
  return parts.join('');
}
