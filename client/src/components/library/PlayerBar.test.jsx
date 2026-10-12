import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import PlayerBar from './PlayerBar.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const track = { id: 1, title: 'Xtal', artist: 'Aphex Twin', durationMs: 240_000 };

function stubPlay(error) {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.reject(error));
}

describe('PlayerBar', () => {
  it('shows a message when playback fails', async () => {
    stubPlay(new DOMException('The element has no supported sources.', 'NotSupportedError'));
    render(<PlayerBar track={track} queue={[track]} onChange={() => {}} onClose={() => {}} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not play this file');
  });

  it('stays quiet when a play() is merely interrupted by a newer load', async () => {
    stubPlay(new DOMException('interrupted', 'AbortError'));
    render(<PlayerBar track={track} queue={[track]} onChange={() => {}} onClose={() => {}} />);

    await act(async () => {}); // let the rejected play() settle
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
