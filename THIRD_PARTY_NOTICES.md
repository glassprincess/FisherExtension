# Third-party notices

## Stockfish

This project includes and talks to Stockfish over UCI.

- Bundled binary: `engine/stockfish.exe` — official Stockfish 19 (release `sf_19`),
  Windows x86-64 universal build.
- Project: https://github.com/official-stockfish/Stockfish
- Release: https://github.com/official-stockfish/Stockfish/releases/tag/sf_19
- Corresponding source: `engine/stockfish-19-source.zip` (also available from the
  upstream repository at tag `sf_19`).
- License: GNU General Public License v3.0 (GPLv3). The full text is in
  `engine/Copying.txt`.

If you redistribute the binary, comply with the GPLv3: provide the corresponding
source code and the license text.

## chess.com

Chess.com is a trademark of Chess.com, LLC. This project is not affiliated with Chess.com.
The test fixtures under `tests/fixtures/` contain small fragments of the chess.com DOM used only to test
interoperability with the site.

The analysis icons under `extension/analysis-icons/` are SVG assets extracted from chess.com
(`wc-eco-opening` / analysis UI). They are included only so the extension can draw the same move
annotations on chess.com pages. They are not covered by this project's MIT license and remain the
property of Chess.com, LLC.

## Project code

The extension, bridge source, tests and install scripts are licensed under the MIT License; see `LICENSE`.
