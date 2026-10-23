# Stockfish

This repository includes the official **Stockfish 19** build for Windows x86-64:

- `engine/stockfish.exe` — universal build, 103,046,300 bytes
- SHA-256: `45BC8E4969147DB9C2EB533810637994619BFF0EACC81CCFD9854394901BCBD0`

The bridge runs it in place and looks for `..\engine\stockfish.exe` relative to
`bin\chess_hint_bridge.exe`.

## Source and license

Stockfish is licensed under **GPLv3**; the full text is in `Copying.txt`.

- Upstream: https://github.com/official-stockfish/Stockfish
- Release: https://github.com/official-stockfish/Stockfish/releases/tag/sf_19
- Corresponding source included here: `stockfish-19-source.zip`
- Build instructions: https://github.com/official-stockfish/Stockfish/wiki/Compiling-from-source
- Prebuilt downloads: https://stockfishchess.org/download/

If you replace the included binary, keep the GPLv3 obligations in mind and use an
official build or build from the upstream source.
