import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HistoryPage from './HistoryPage.jsx';
import { addEntry, getHistory } from '../lib/history.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('HistoryPage', () => {
  it('only clears history after an inline confirm', async () => {
    addEntry({ track: 'Roygbiv', artist: 'Boards of Canada', action: 'verified' });
    const user = userEvent.setup();
    render(<HistoryPage />);

    await user.click(screen.getByRole('button', { name: 'Clear All' }));
    expect(getHistory()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Roygbiv')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear All' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(getHistory()).toHaveLength(0);
    expect(screen.getByText('No history yet.')).toBeInTheDocument();
  });

  it('drops legacy MeTube "sent" entries instead of labelling them Verified', () => {
    localStorage.setItem('spinmatch:history', JSON.stringify([
      { track: 'Sent one', artist: 'A', action: 'sent', timestamp: 3 },
      { track: 'Checked', artist: 'A', action: 'verified', timestamp: 2 },
      { track: 'Moved in', artist: 'A', action: 'ingested', timestamp: 1 },
    ]));
    render(<HistoryPage />);

    expect(screen.queryByText('Sent one')).not.toBeInTheDocument();
    expect(screen.getByText('Checked').closest('tr')).toHaveTextContent('Verified');
    expect(screen.getByText('Moved in').closest('tr')).toHaveTextContent('Ingested');
  });
});
