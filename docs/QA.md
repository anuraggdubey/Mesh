# QA log

## Render determinism

| Case | Expected | Actual |
| --- | --- | --- |
| `tiny` preset, all 4 tiles, native macOS arm64 Go run vs `linux/amd64` Docker image | Every output tile matches byte-for-byte | Pass; hashes are in [`golden/render-tiny.json`](golden/render-tiny.json) |
| Echo job, raw file and `/input/job.json` mounts, `--network none --read-only` | `/output/tile-0` matches input bytes | Pass |
| Full render, 2048×2048, 64 tiles, 48,000 iterations | Complete in 20–40 seconds on provider hardware | Pass; 28.87 seconds with 15 CPUs and 1 GiB Docker memory |
| Small render, 2048×2048, 64 tiles, 6,000 iterations | Complete in about 5 seconds | Pass; 4.06 seconds with the same Docker limits |

The cross-architecture comparison used the same physical Mac for the native arm64 process and the `linux/amd64` container. The tiny preset still needs to be run on Anurag's machine and recorded here.

## Verifier sampling detection simulation

Reproduce with `npx tsx scripts/verifier-detection.ts`. Each cell runs 1,000 deterministic simulated post-claim block hashes through the production sampler with 64 tiles. The first `c` tiles are treated as corrupted, and a detection is counted when the sample includes one. Expected probability is the exact without-replacement value `1 − C(64−c, k) / C(64, k)`; each cell passed a four-standard-error check (with a 3 percentage-point minimum tolerance).

| Corrupted tiles (`c`) | Sample size (`k`) | Detected / 1,000 | Observed | Expected |
| ---: | ---: | ---: | ---: | ---: |
| 6 | 8 | 573 | 57.3% | 56.7% |
| 6 | 16 | 850 | 85.0% | 83.6% |
| 6 | 32 | 986 | 98.6% | 98.8% |
| 12 | 8 | 838 | 83.8% | 83.0% |
| 12 | 16 | 979 | 97.9% | 97.9% |
| 12 | 32 | 999 | 99.9% | 100.0% |
| 20 | 8 | 962 | 96.2% | 96.0% |
| 20 | 16 | 999 | 99.9% | 99.9% |
| 20 | 32 | 1,000 | 100.0% | 100.0% |

This validates the deterministic sampling distribution only; it does not exercise Docker recomputation, fraud transactions, or a live Hedera claim.
