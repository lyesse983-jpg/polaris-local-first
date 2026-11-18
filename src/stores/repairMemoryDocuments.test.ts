import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kvGet, kvSet, kvEntries, setPersistenceBackendForTesting, type PersistedDbEntry, type PersistedKvMutation, type PersistenceBackend } from '../infrastructure/persistence';
import { resetStoreLocalDataBackendForTesting } from './storeLocalDataBackendHost';
import { createPersonaTemplate } from '../config/persona/personaBuilder';
import { writeChatStateToLocalDataRepository } from './chat/snapshotWrite';
import { readCompleteLiveChatState } from './chatCurrentPersistence';
import { useChatStore } from './chatStore';
import { usePersonaStore } from './personaStore';
import { useCollectionStore } from './collectionStore';
import { buildCurrentExportPackage } from '../app/shell/completeBackupExport';
import { clearStagedPersonaMemoryDocContent, writePersonaMemoryDocContentForPersonas, loadPersonaMemoryReferenceDocsContent } from './personaMemoryReferenceDocPersistence';
import { repairMemoryDocumentsFromBackup } from './repairMemoryDocuments';
import { createStoreLocalDataRepository } from './localDataStorePersistence';
import { getDocumentObjectLocalDataRef } from '../engines/localData';
import { commitDocumentRowChangesActivating, restoreMissingDocumentBodies } from './documentLocalDataPersistence';
import { buildDocumentLocalDataStateFromSources } from '../engines/localData';
import type { Persona } from '../types/domain';

function createMemoryPersistenceBackend(initialKv: PersistedDbEntry[] = []): PersistenceBackend {
  const stores = new Map<string, Map<string, unknown>>();
  stores.set('kv', new Map(initialKv.map((entry) => [entry.key, entry.value])));
  const getStore = (storeName: string) => {
    let store = stores.get(storeName);
    if (!store) {
      store = new Map();
      stores.set(storeName, store);
    }
    return store;
  };
  return {
    async dbStoreGet<T>(storeName: string, key: string) {
      return (getStore(storeName).get(key) as T | undefined) ?? null;
    },
    async dbStoreSet(storeName: string, key: string, value: unknown) {
      getStore(storeName).set(key, value);
    },
    async dbStoreDelete(storeName: string, key: string) {
      getStore(storeName).delete(key);
    },
    async dbStoreEntries<T>(storeName: string) {
      return Array.from(getStore(storeName).entries()).map(([key, value]) => ({ key, value: value as T }));
    },
    async dbStoreKeys(storeName: string) {
      return Array.from(getStore(storeName).keys());
    },
    async dbStoreClear(storeName: string) {
      getStore(storeName).clear();
    },
    async kvApplyMutations(mutations: PersistedKvMutation[]) {
      const store = getStore('kv');
      for (const mutation of mutations) {
        if (mutation.type === 'set') store.set(mutation.key, mutation.value);
        else store.delete(mutation.key);
      }
    },
    async kvReplaceAll(entries) {
      stores.set('kv', new Map(entries.map((entry) => [entry.key, entry.value])));
    }
  };
}


const bodies = Array.from({length: 4}, (_, i) => `合成文档 ${i} 😀\n`.repeat(9000));
function persona(loaded = false) {
  return createPersonaTemplate({ id: 'owner', name: 'Owner', description: 'current personality', memory: {
    referenceDocs: bodies.map((body, i) => ({id: `doc-${i}`, title: `Doc ${i}`, summary: '',
      content: loaded ? body : '', charCount: body.length, contentLoaded: loaded, updatedAt: 10 + i, source: 'upload' as const}))
  }});
}
async function originalBackup(options: { duplicate?: boolean; newer?: boolean; missing?: boolean } = {}) {
  const p = persona(false);
  if (options.duplicate) p.memory.referenceDocs.push(p.memory.referenceDocs[0]);
  if (options.newer) p.memory.referenceDocs.forEach(doc => doc.updatedAt += 1);
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'polaris-export', version: 1, stores: {
    persona: 'stores/persona.json', personaMemoryDocContent: 'stores/persona-memory-doc-content.json'
  }}));
  zip.file('stores/persona.json', new TextEncoder().encode(JSON.stringify({personas: [p]})));
  zip.file('stores/persona-memory-doc-content.json', new TextEncoder().encode(JSON.stringify({ version: 1,
    docs: options.missing ? {} : Object.fromEntries(bodies.map((body, i) => [`owner:doc-${i}`, body]))
  })));
  return zip.generateAsync({type: 'blob'});
}
const originalPersonaState = usePersonaStore.getState();
const originalCollectionState = useCollectionStore.getState();
beforeEach(() => {
  resetStoreLocalDataBackendForTesting();
  setPersistenceBackendForTesting(createMemoryPersistenceBackend());
  clearStagedPersonaMemoryDocContent();
});
afterEach(() => {
  vi.restoreAllMocks();
  usePersonaStore.setState(originalPersonaState, true);
  useCollectionStore.setState(originalCollectionState, true);
  clearStagedPersonaMemoryDocContent();
  resetStoreLocalDataBackendForTesting();
  setPersistenceBackendForTesting(null);
});

describe('ordinary backup and missing memory body repair', () => {
  it('exports four unopened bodies through the actual ordinary backup entry, not only persisted export', async () => {
    const loaded = persona(true);
    await writePersonaMemoryDocContentForPersonas([loaded]);
    clearStagedPersonaMemoryDocContent();
    usePersonaStore.setState({ personas: [persona(false)], activeCollaboratorId: 'owner' });
    useCollectionStore.setState({ cards: [], projectFiles: [], workspaceReferenceDocs: [], roomProjects: [], imageCards: [], deletedBundledCardIds: [] });
    vi.spyOn(useChatStore.getState(), 'persistToDb').mockResolvedValue();
    const exported = await buildCurrentExportPackage();
    const zip = await JSZip.loadAsync(await exported.blob.arrayBuffer());
    const payload = JSON.parse(await zip.file('stores/persona-memory-doc-content.json')!.async('string'));
    expect(payload.docs).toEqual(Object.fromEntries(bodies.map((body, i) => [`owner:doc-${i}`, body])));
    expect(usePersonaStore.getState().personas[0].memory.referenceDocs.every(doc => doc.contentLoaded === false)).toBe(true);
    // The exported archive itself can repair an empty document store, preserving exact text.
    resetStoreLocalDataBackendForTesting();
    setPersistenceBackendForTesting(createMemoryPersistenceBackend());
    const result = await repairMemoryDocumentsFromBackup(exported.blob, () => [persona(false)]);
    expect(result).toMatchObject({ repaired: 4, unresolved: 0 });
    const restored = await loadPersonaMemoryReferenceDocsContent([persona(false)]);
    expect(restored[0].memory.referenceDocs.map(doc => doc.content)).toEqual(bodies);
  });

  it('repairs only missing bodies and leaves chats, settings, existing bodies and directory objects untouched', async () => {
    const current = [persona(false)];
    const before = structuredClone(current);
    await kvSet('sentinel-chat', { content: 'new chat after original backup' });
    await kvSet('sentinel-settings', { provider: 'current' });
    await writeChatStateToLocalDataRepository({ conversations: [{ id: 'new-chat', title: 'Current chat',
      kind: 'direct', collaboratorId: 'owner', activeProjectId: null, draft: '', pinnedAt: null,
      updatedAt: 100, messages: [{ id: 'new-message', role: 'user', content: 'new chat after original backup', timestamp: 100 }]
    }], activeConversationId: 'new-chat' }, 'active');
    const chatBefore = await readCompleteLiveChatState({ throwOnReadFailure: true });
    const original = await originalBackup();
    expect(await repairMemoryDocumentsFromBackup(original, () => current)).toMatchObject({ repaired: 4, unresolved: 0 });
    expect(current).toEqual(before);
    expect(await readCompleteLiveChatState({ throwOnReadFailure: true })).toEqual(chatBefore);
    expect(await kvGet('sentinel-chat')).toEqual({content: 'new chat after original backup'});
    expect(await kvGet('sentinel-settings')).toEqual({provider: 'current'});
    const rowsBefore = await kvEntries();
    expect((await repairMemoryDocumentsFromBackup(original, () => current)).repaired).toBe(0);
    expect(await kvEntries()).toEqual(rowsBefore);
    // An edited complete body must survive recovery from an older backup even if UI is still unloaded.
    const edited = persona(true); edited.memory.referenceDocs[0].content = 'newer body'; edited.memory.referenceDocs[0].updatedAt = Date.now();
    await writePersonaMemoryDocContentForPersonas([edited]);
    expect((await repairMemoryDocumentsFromBackup(original, () => current)).repaired).toBe(0);
    const row = await createStoreLocalDataRepository().read<{ content: string }>(getDocumentObjectLocalDataRef('persona-memory-doc', 'owner:doc-0'));
    expect(row.status === 'complete' && row.value.content).toBe('newer body');
  });

  it('does not substitute mismatched document versions or absent backup bodies', async () => {
    for (const options of [{newer: true}, {missing: true}]) {
      expect(await repairMemoryDocumentsFromBackup(await originalBackup(options), () => [persona(false)]))
        .toMatchObject({ repaired: 0, unresolved: 4 });
    }
    expect(await kvEntries()).toEqual([]);
  });

  it('propagates body read failure without converting it into an absent row or writing a repair', async () => {
    const backend = createMemoryPersistenceBackend();
    const read = backend.dbStoreGet.bind(backend);
    backend.dbStoreGet = async (store, key) => {
      if (key.startsWith('local-data-v1:row:document:persona-memory-doc:')) throw new Error('synthetic read failure');
      return read(store, key);
    };
    setPersistenceBackendForTesting(backend);
    await expect(repairMemoryDocumentsFromBackup(await originalBackup(), () => [persona(false)])).rejects.toThrow('untrusted');
    expect(await kvEntries()).toEqual([]);
  });

  it('rejects duplicate source documents before any write', async () => {
    await expect(repairMemoryDocumentsFromBackup(await originalBackup({duplicate: true}), () => [persona(false)]))
      .rejects.toThrow('重复文档');
    expect(await kvEntries()).toEqual([]);
  });

  it('rechecks user edits in the document queue and preserves explicit tombstones', async () => {
    const loaded = persona(true);
    const state = buildDocumentLocalDataStateFromSources({ kv: [], personas: [loaded], workspaceReferenceDocs: [], updatedAt: 1 });
    expect(await restoreMissingDocumentBodies({ seeds: state.documents, isStillExpected: () => false })).toEqual([]);
    expect(await kvEntries()).toEqual([]);
    await writePersonaMemoryDocContentForPersonas([loaded]);
    await commitDocumentRowChangesActivating({changes: [{type: 'delete', kind: 'persona-memory-doc', id: 'owner:doc-0'}]});
    const before = await kvEntries();
    expect((await repairMemoryDocumentsFromBackup(await originalBackup(), () => [persona(false)])).repaired).toBe(0);
    const row = await createStoreLocalDataRepository().read(getDocumentObjectLocalDataRef('persona-memory-doc', 'owner:doc-0'));
    expect(row.status).toBe('deleted');
    expect(await kvEntries()).toEqual(before);
  });
});
