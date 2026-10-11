import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WriteResultBanner from './WriteResultBanner.jsx';
import ChangesTab from './ChangesTab.jsx';
import TagEditPanel from './TagEditPanel.jsx';
import { installFetchMock, errorResponse, jsonResponse } from '../../test/fetchMock.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function undoRoute(id, body, status = 200) {
  return {
    method: 'POST',
    test: (url) => url === `/api/library/changes/${id}/undo`,
    respond: () => jsonResponse(body, { status }),
  };
}

describe('WriteResultBanner undo', () => {
  it('offers no Undo when nothing was journaled', () => {
    render(<WriteResultBanner result={{ applied: [], failed: [], batchId: null }} />);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('undoes the batch after an inline confirm and reports conflicts', async () => {
    const calls = installFetchMock([undoRoute(7, {
      undone: 1, conflicts: [{ path: '/music/b.mp3', reason: 'The file changed after this edit.' }], failed: [],
    })]);
    const onUndone = vi.fn();
    const user = userEvent.setup();
    render(<WriteResultBanner result={{ applied: [{}, {}], failed: [], batchId: 7 }} onUndone={onUndone} />);

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Confirm undo' }));

    expect(await screen.findByText('Put back the previous tags on 1 file.')).toBeInTheDocument();
    expect(screen.getByText(/\/music\/b\.mp3: The file changed/)).toBeInTheDocument();
    expect(calls).toEqual([{ url: '/api/library/changes/7/undo', method: 'POST', body: {} }]);
    expect(onUndone).toHaveBeenCalledTimes(1);
  });

  it('shows the server error when the batch was already undone', async () => {
    installFetchMock([undoRoute(7, { error: { code: 'CONFLICT', message: 'This change has already been undone' } }, 409)]);
    const user = userEvent.setup();
    render(<WriteResultBanner result={{ applied: [{}], failed: [], batchId: 7 }} />);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await user.click(screen.getByRole('button', { name: 'Confirm undo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This change has already been undone');
  });
});

describe('ChangesTab', () => {
  it('lists changes newest first and undoes one', async () => {
    const calls = installFetchMock([
      {
        test: (url) => url.startsWith('/api/library/changes?'),
        respond: () => jsonResponse({
          total: 2,
          changes: [
            { id: 2, kind: 'album-edit', label: 'Album tags: A – B', createdAt: 2000, undoneAt: null, files: 12 },
            { id: 1, kind: 'edit', label: 'Edited tags: A – T', createdAt: 1000, undoneAt: 1500, files: 1 },
          ],
        }),
      },
      undoRoute(2, { undone: 12, conflicts: [], failed: [] }),
    ]);
    const onUndone = vi.fn();
    const user = userEvent.setup();
    render(<ChangesTab onUndone={onUndone} />);

    expect(await screen.findByText('Album tags: A – B')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText(/^Undone /)).toBeInTheDocument();
    // Only the live batch is undoable.
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await user.click(screen.getByRole('button', { name: 'Confirm undo' }));
    expect(await screen.findByText('Put back the previous tags on 12 files.')).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({ url: '/api/library/changes/2/undo', method: 'POST' });
    expect(onUndone).toHaveBeenCalled();
  });

  it('shows a load failure with a retry', async () => {
    installFetchMock([{ test: () => true, respond: () => errorResponse({ error: { message: 'boom' } }, { status: 500 }) }]);
    render(<ChangesTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('TagEditPanel', () => {
  it('sends the mtime it loaded so the server can refuse a stale file', async () => {
    const calls = installFetchMock([{
      method: 'PATCH',
      test: (url) => url === '/api/library/track/5/tags',
      respond: () => jsonResponse({ trackId: 5, changedFields: ['title'], batchId: 3 }),
    }]);
    const user = userEvent.setup();
    const track = { id: 5, title: 'Old', mtimeMs: 1234567 };
    render(<TagEditPanel track={track} onSaved={vi.fn()} onCancel={vi.fn()} />);

    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'New');
    await user.click(screen.getByRole('button', { name: /Review 1 change/ }));
    await user.click(screen.getByRole('button', { name: 'Write these tags' }));

    expect(calls[0].body).toEqual({ fields: { title: 'New' }, expectedMtimeMs: 1234567 });
  });
});
