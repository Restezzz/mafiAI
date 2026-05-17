import { collectAudioUrls } from './audioPreloader';

describe('collectAudioUrls', () => {
  it('collects unique name, variant, and name-pair audio urls', () => {
    const urls = collectAudioUrls({
      version: 'test',
      names: [
        { intro_audio: '/audio/name-a.mp3' },
        { intro_audio: '/audio/name-a.mp3' },
      ],
      triggers: {
        intro: {
          variants: [
            { audio_url: '/audio/intro.mp3' },
          ],
        },
        killed: {
          pairs: [
            {
              opener: { audio_url: '/audio/open.mp3' },
              closer: { audio_url: '/audio/close.mp3' },
            },
          ],
        },
      },
    }).sort();

    expect(urls).toEqual([
      '/audio/close.mp3',
      '/audio/intro.mp3',
      '/audio/name-a.mp3',
      '/audio/open.mp3',
    ]);
  });
});
