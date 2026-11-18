import JSZip from 'jszip';
import type { Persona, PersonaMemoryReferenceDoc } from '../types/domain';
import { buildDocumentLocalDataStateFromSources } from '../engines/localData';
import { restoreMissingDocumentBodies } from './documentLocalDataPersistence';
import { docContentKey } from './personaMemoryReferenceDocPersistence';

type RepairResult = { repaired: number; unresolved: number };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads only the document directory and bodies from an explicitly selected backup.
 * Never imports its chats, provider credentials, personas or other domains. */
export async function repairMemoryDocumentsFromBackup(
  file: Blob,
  getPersonas: () => Persona[]
): Promise<RepairResult> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  async function read(path: string): Promise<unknown> {
    const entry = zip.file(path);
    if (!entry) throw new Error('备份缺少文档所需的文件，未执行补回。');
    return JSON.parse(await entry.async('string'));
  }
  const manifest = await read('manifest.json');
  if (!record(manifest) || manifest.format !== 'polaris-export' || manifest.version !== 1
    || !record(manifest.stores) || manifest.stores.persona !== 'stores/persona.json'
    || (manifest.stores.personaMemoryDocContent !== undefined
      && manifest.stores.personaMemoryDocContent !== 'stores/persona-memory-doc-content.json')) {
    throw new Error('请选择 Polaris 的完整备份，用于补回记忆文档。');
  }
  const source = await read('stores/persona.json');
  const bodyPayload = manifest.stores.personaMemoryDocContent
    ? await read('stores/persona-memory-doc-content.json') : null;
  if (!record(source) || !Array.isArray(source.personas)
    || (bodyPayload !== null && (!record(bodyPayload) || !record(bodyPayload.docs)))) {
    throw new Error('备份的记忆文档格式不正确，未执行补回。');
  }
  const sourceDocs = new Map<string, { updatedAt: number; content: string }>();
  const seen = new Set<string>();
  for (const persona of source.personas) {
    if (!record(persona) || typeof persona.id !== 'string' || !record(persona.memory)
      || !Array.isArray(persona.memory.referenceDocs)) throw new Error('备份的协作者文档目录不完整。');
    for (const doc of persona.memory.referenceDocs) {
      if (!record(doc) || typeof doc.id !== 'string') throw new Error('备份的文档目录不正确。');
      const key = docContentKey(persona.id, doc.id);
      if (seen.has(key)) throw new Error('备份包含重复文档，未执行补回。');
      seen.add(key);
      const content = record(bodyPayload) && record(bodyPayload.docs) && typeof bodyPayload.docs[key] === 'string'
        ? bodyPayload.docs[key] : doc.content;
      if (typeof content !== 'string' || typeof doc.updatedAt !== 'number'
        || (typeof doc.charCount === 'number' && content.length < doc.charCount)) continue;
      sourceDocs.set(key, { updatedAt: doc.updatedAt, content });
    }
  }
  const expected = new Map<string, { personaId: string; doc: PersonaMemoryReferenceDoc }>();
  const candidates: Persona[] = [];
  let unresolved = 0;
  for (const persona of getPersonas()) {
    const referenceDocs: PersonaMemoryReferenceDoc[] = [];
    for (const doc of persona.memory.referenceDocs) {
      // An explicitly loaded/edited body is already current truth, including an empty one.
      if (doc.contentLoaded || doc.content.length > 0 || !(doc.charCount && doc.charCount > 0)) continue;
      const key = docContentKey(persona.id, doc.id);
      const body = sourceDocs.get(key);
      if (!body || body.updatedAt !== doc.updatedAt || body.content.length !== doc.charCount) {
        unresolved += 1;
        continue;
      }
      expected.set(key, { personaId: persona.id, doc });
      referenceDocs.push({ ...doc, content: body.content, contentLoaded: true });
    }
    if (referenceDocs.length) candidates.push({ ...persona, memory: { ...persona.memory, referenceDocs } });
  }
  const state = buildDocumentLocalDataStateFromSources({
    kv: [], personas: candidates, workspaceReferenceDocs: [], updatedAt: Date.now()
  });
  if (!state.documents.length) return { repaired: 0, unresolved };
  const repaired = await restoreMissingDocumentBodies({
    seeds: state.documents,
    isStillExpected: (seed) => {
      const target = expected.get(seed.id);
      const current = target && getPersonas().find((persona) => persona.id === target.personaId)
        ?.memory.referenceDocs.find((doc) => doc.id === target.doc.id);
      return !!current && !current.contentLoaded && current.content.length === 0
        && current.updatedAt === target!.doc.updatedAt && current.charCount === target!.doc.charCount;
    }
  });
  return { repaired: repaired.length, unresolved };
}
