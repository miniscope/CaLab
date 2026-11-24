# GPU compressor: how short may a factor window be

## Data

The 24 Nov window dumps, first 1,200 frames of each:

- V4: `cafast_v4_3h` files 17-19, 600 x 600 px (100 tiles of 64 px).
- wl24: `wl24_20251201` from frame 20,000, 200 x 200 px (16 tiles).

## Method

The same 1,200 frames compressed as 2 x 600, 4 x 300 and 8 x 150 windows, per 64 px tile, with today's CPU
algorithm (randomized SVD, lag-1 rank cut, numpy port). Residual share is the part of the centred frames the
factors leave out (noise plus what the cut dropped). Bytes per frame count the factors (U, V, 3 floats per pixel).

## Result

| Recording | W   | Mean rank | Residual share | Bytes/frame |
| --------- | --- | --------- | -------------- | ----------- |
| wl24      | 600 | 22.06     | 0.5570         | 10,143      |
| wl24      | 300 | 13.59     | 0.5897         | 11,822      |
| wl24      | 150 | 6.82      | 0.6550         | 13,007      |
| V4        | 600 | 7.58      | 0.6315         | 29,818      |
| V4        | 300 | 5.88      | 0.6777         | 46,853      |
| V4        | 150 | 4.58      | 0.7216         | 77,024      |

## Rule and ladder

A length is allowed if its mean rank is within 10 % of W = 600's and its residual share within 1 % of W = 600's, on
both recordings.

W = 300 fails on both: rank is 62 % (wl24) and 78 % (V4) of W = 600's, and the residual share is 0.033 / 0.046
higher. W = 150 fails by more. Shorter windows also cost more bytes per frame (the per-pixel terms are amortised over
fewer frames).

Ladder: `GPU_WINDOW_LADDER = [600]`. No shorter window keeps the signal, so memory pressure must be met by other
means than a shorter window.
