import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemoteImageUrl, pickNormalizedImageUrl } from './avatarUrl.ts';

test('normalizeRemoteImageUrl handles protocol-relative Garmin urls', () => {
  assert.equal(
    normalizeRemoteImageUrl('//static.garmincdn.com/avatar.png'),
    'https://static.garmincdn.com/avatar.png',
  );
});

test('normalizeRemoteImageUrl resolves relative Garmin paths', () => {
  assert.equal(
    normalizeRemoteImageUrl('/profile/avatar/runner.jpg'),
    'https://connect.garmin.com/profile/avatar/runner.jpg',
  );
});

test('pickNormalizedImageUrl falls back across multiple sources', () => {
  assert.equal(
    pickNormalizedImageUrl(
      [
        { profileImageUrlLarge: '' },
        { profileImageUrlMedium: '//images.example.com/avatar-medium.jpg' },
      ],
      ['profileImageUrlLarge', 'profileImageUrlMedium'],
    ),
    'https://images.example.com/avatar-medium.jpg',
  );
});
