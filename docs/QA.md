# QA log

## Render determinism

| Case | Expected | Actual |
| --- | --- | --- |
| `tiny` preset, all 4 tiles, native macOS arm64 Go run vs `linux/amd64` Docker image | Every output tile matches byte-for-byte | Pass; hashes are in [`golden/render-tiny.json`](golden/render-tiny.json) |
| Echo job, raw file and `/input/job.json` mounts, `--network none --read-only` | `/output/tile-0` matches input bytes | Pass |
| Full render, 2048×2048, 64 tiles, 48,000 iterations | Complete in 20–40 seconds on provider hardware | Pass; 28.87 seconds with 15 CPUs and 1 GiB Docker memory |
| Small render, 2048×2048, 64 tiles, 6,000 iterations | Complete in about 5 seconds | Pass; 4.06 seconds with the same Docker limits |

The cross-architecture comparison used the same physical Mac for the native arm64 process and the `linux/amd64` container. The tiny preset still needs to be run on Anurag's machine and recorded here.
