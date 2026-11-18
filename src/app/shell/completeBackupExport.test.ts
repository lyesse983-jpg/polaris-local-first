import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Persona, WorkspaceReferenceDoc } from '../../types/domain';
import { useChatStore } from '../../stores/chatStore';
import { useCollectionStore } from '../../stores/collectionStore';
import { loadWorkspaceReferenceDocsContent } from '../../stores/workspaceReferenceDocContentPersistence';
import { usePersonaStore } from '../../stores/personaStore';
import { createPersonaTemplate } from '../../config/persona/personaBuilder';
import { loadPersonaMemoryReferenceDocsContent } from '../../stores/personaMemoryReferenceDocPersistence';
import { prepareCompleteExportSnapshot } from './completeBackupExport';

vi.mock('../../stores/workspaceReferenceDocContentPersistence', () => ({
  loadWorkspaceReferenceDocsContent: vi.fn()
}));

vi.mock('../../stores/personaMemoryReferenceDocPersistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../stores/personaMemoryReferenceDocPersistence')>(),
  loadPersonaMemoryReferenceDocsContent: vi.fn(async (personas: Persona[]) => personas.map((persona) => ({ ...persona, memory: { ...persona.memory, referenceDocs: persona.memory.referenceDocs.map((doc) => ({ ...doc, charCount: doc.charCount ?? doc.content.length, contentLoaded: true as const })) } })))
}));

function referenceDoc(patch: Partial<WorkspaceReferenceDoc> = {}): WorkspaceReferenceDoc {
  return {
    id: 'workspace-doc-1',
    projectId: 'workspace-1',
    title: 'Reference',
    summary: '',
    content: '',
    charCount: 12,
    contentLoaded: false,
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    ...patch
  };
}

describe('prepareCompleteExportSnapshot', () => {
  const originalCollectionState = useCollectionStore.getState();
  const originalPersonaState = usePersonaStore.getState();

  afterEach(() => {
    vi.restoreAllMocks();
    useCollectionStore.setState(originalCollectionState, true);
    usePersonaStore.setState(originalPersonaState, true);
    vi.mocked(loadPersonaMemoryReferenceDocsContent).mockClear();
    vi.mocked(loadPersonaMemoryReferenceDocsContent).mockImplementation(async (personas) => personas.map((persona) => ({ ...persona, memory: { ...persona.memory, referenceDocs: persona.memory.referenceDocs.map((doc) => ({ ...doc, charCount: doc.charCount ?? doc.content.length, contentLoaded: true as const })) } })));
  });

  it('loads all four unopened memory document bodies for the ordinary backup button', async () => {
    vi.spyOn(useChatStore.getState(), 'persistToDb').mockResolvedValue();
    vi.mocked(loadWorkspaceReferenceDocsContent).mockResolvedValue([]);
    useCollectionStore.setState({ workspaceReferenceDocs: [] });
    const persona = createPersonaTemplate({ id: 'memory-owner', name: 'Owner', description: '', memory: {
      referenceDocs: Array.from({ length: 4 }, (_, i) => ({
        id: `memory-${i}`, title: `Memory ${i}`, summary: '', content: '', charCount: 10,
        contentLoaded: false, source: 'upload' as const, updatedAt: 1
      }))
    } });
    const loaded = { ...persona, memory: { ...persona.memory, referenceDocs: persona.memory.referenceDocs.map((doc) => ({
      ...doc, content: 'exact body', charCount: 10, contentLoaded: true as const
    })) } };
    usePersonaStore.setState({ personas: [persona], activeCollaboratorId: persona.id });
    vi.mocked(loadPersonaMemoryReferenceDocsContent).mockResolvedValue([loaded]);
    const snapshot = await prepareCompleteExportSnapshot();
    expect(loadPersonaMemoryReferenceDocsContent).toHaveBeenCalledWith([persona]);
    expect(snapshot.personaState?.personas).toEqual([loaded]);
    expect(usePersonaStore.getState().personas[0].memory.referenceDocs[0].contentLoaded).toBe(false);
  });

  it('stops complete backup creation when a memory body cannot be read', async () => {
    vi.spyOn(useChatStore.getState(), 'persistToDb').mockResolvedValue();
    vi.mocked(loadWorkspaceReferenceDocsContent).mockResolvedValue([]);
    vi.mocked(loadPersonaMemoryReferenceDocsContent).mockRejectedValue(new Error('Memory body unreadable'));
    await expect(prepareCompleteExportSnapshot()).rejects.toThrow('Memory body unreadable');
  });

  it('loads workspace reference document bodies before building a complete backup', async () => {
    const shell = referenceDoc();
    const loaded = {
      ...referenceDoc(),
      content: 'full content',
      charCount: 12,
      contentLoaded: true as const
    } satisfies WorkspaceReferenceDoc;
    vi.spyOn(useChatStore.getState(), 'persistToDb').mockResolvedValue();
    vi.mocked(loadWorkspaceReferenceDocsContent).mockResolvedValue([loaded]);
    useCollectionStore.setState({ workspaceReferenceDocs: [shell] });

    const snapshot = await prepareCompleteExportSnapshot();

    expect(loadWorkspaceReferenceDocsContent).toHaveBeenCalledWith([shell]);
    expect(snapshot.collectionState?.workspaceReferenceDocs).toEqual([loaded]);
  });

  it('fails the backup when a declared workspace document body cannot be loaded', async () => {
    vi.spyOn(useChatStore.getState(), 'persistToDb').mockResolvedValue();
    vi.mocked(loadWorkspaceReferenceDocsContent).mockRejectedValue(
      new Error('Workspace reference document content is missing')
    );
    useCollectionStore.setState({ workspaceReferenceDocs: [referenceDoc()] });

    await expect(prepareCompleteExportSnapshot()).rejects.toThrow(
      'Workspace reference document content is missing'
    );
  });
});
