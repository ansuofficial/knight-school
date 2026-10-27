# Knight School

Learn chess one move at a time. Short hands-on lessons on a 3D wooden board, then friendly games with a coach who explains every move.

- Nine short lessons, from the board and how each piece moves to forks, pins, good openings and chess notation. Each one teaches one idea, then gives you a task on the board, like collecting stars with a piece or finding the right move.
- Chess words like *fork* or *en passant* can be tapped for a short meaning, and there's a glossary of them all.
- A real 3D board with turned wooden pieces and a carved knight. Turn it and tilt it, and watch the pieces lift, glide and land.
- Play a friendly computer at three levels: Beginner, Casual and Challenging. Ask for a hint, undo a move, and read the coach, who names every move in plain words with its notation, like "Knight to f3 (Nf3)", and warns you when one of your pieces can be taken for free.
- Every rule of chess, including castling, en passant, promotion, stalemate and the draw rules.
- Works on phones, tablets and computers, with touch, a mouse or the keyboard. Sounds are made in the browser and can be turned off.

## Play it on your computer

1. At the top of this page, click the green **Code** button, then **Download ZIP**.
2. Unzip the file you downloaded. You get a folder called `knight-school-main`.
3. Open that folder and double-click `index.html`. The game opens in your web browser.

There's nothing to install and no account to make. The board is drawn with WebGL, which every current browser has.

## How to play

- Press **Start**, or the Enter key, to begin.
- Choose **Learn** for the lessons or **Play** for a game. Finished lessons are saved, so you can stop and come back.
- To move, tap or click a piece, then the square to move it to. Dots show where it can go, and rings show pieces it can take.
- Drag the board to turn and tilt it. Pinch, or use the mouse wheel, to zoom. The round arrow button puts the view back.
- In a lesson, tap any blue word to see what it means. If a task gives you trouble, **Show me** marks the right move.
- In a game, **Hint** shows a good move and why, and **Undo** takes back your last move.
- With a keyboard, the arrow keys move a blue outline over the squares, and Enter or Space picks the square under it. Up always means away from you, however the board is turned. Tab moves through the buttons.
- Press **Esc** to put down a picked-up piece or close a word card. Chess here has no clock, so there's nothing to pause.
- Press **M** to turn sound on or off.

## Change it

The settings are at the top of `src/game.js`. After any change, run `python3 build.py` (plain Python 3, no packages), then reload `index.html`.

**Computer levels.** Each level is one line in `LEVELS`:

```js
const LEVELS = {
  beginner:    { depth: 1, extra: 0, noise: 150, blunder: 0.12 },
  casual:      { depth: 2, extra: 2, noise: 40,  blunder: 0.02 },
  challenging: { depth: 3, extra: 4, noise: 8,   blunder: 0 },
  hint:        { depth: 3, extra: 4, noise: 0,   blunder: 0 }
};
```

- `depth` is how many moves ahead it looks. Each one more makes it stronger and slower.
- `extra` is how many captures it keeps following after that, so it doesn't stop thinking in the middle of a trade.
- `noise` adds random points to every move it weighs. 100 points is one pawn, so a bigger number means more mistakes.
- `blunder` is the chance, from 0 to 1, that it plays a random move.
- `hint` is the coach's own suggestion, so it never plays at random.

The line under each level on the Play screen comes from `LEVEL_NOTE`.

**Lessons.** The lessons are in `LESSONS`, further down in `src/game.js`, in the order they appear. Each step is one of four kinds: `info` (read, then press Next), `tap` (find named squares), `stars` (collect stars with one piece) or `goal` (play the right move). Positions are written in FEN, the standard way to write down a chess position. Put a word in double square brackets, like `[[fork]]`, to make it a tappable chip. Its meaning comes from `GLOSS`, which is also the glossary.

**Speed and view.** `THINK` is the shortest time the computer takes before it moves, in milliseconds. `MOTION` speeds up or slows down every animation: 0.5 is twice as fast. `CAMERA` sets the tilt, how fast the board turns on the menus, and how far you can zoom.

**The look.** Colors are CSS variables in the `:root` block of `src/page.html`. The board, the pieces and the star are made in code in `src/pieces.js`: change the wood colors in `WOOD` and `PIECE_MAT`, or the shape of a piece in `BODY`.

## Put it online for free

Knight School is a few plain files with no build step needed to run it, so any free static web host can serve it. With GitHub Pages:

1. Sign in to GitHub and click **Fork** at the top of this page to make your own copy.
2. In your copy, open **Settings**, then **Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and click **Save**.
4. After a minute or two, your game is live at `https://<your-username>.github.io/knight-school/`.

On another host, upload these three files together:

- `index.html`: the game
- `og-image.png`: the picture shown when the link is shared
- `apple-touch-icon.png`: the icon for "Add to Home Screen" on iPhone and iPad

### Nicer link previews (optional)

The game works without this step. LinkedIn and X only show the preview picture when the page gives its full address, so once you know where the game lives, rebuild with that address (ending in a slash) and upload the new `index.html`:

```
python3 build.py --url https://<your-username>.github.io/knight-school/
```

## Project layout

```
index.html            the built game (deploy this)
build.py              joins src/ into index.html
src/page.html         title, colors, fonts, styles and the screens
src/game.js           the game: settings, chess rules, computer player, lessons, coach, input, sounds, saving
src/pieces.js         the wooden board, the pieces and the lesson star, made in code
src/three.min.js      three.js r128, the 3D library (built into index.html)
src/favicon.png       the tab icon (built into index.html)
og-image.png          link preview picture, 1200 x 630
apple-touch-icon.png  home screen icon, 180 x 180
```

## How it works

- Plain HTML, CSS and JavaScript, with three.js for the 3D board. three.js is built into `index.html`, so the game loads nothing from other sites. The board, the pieces and the wood grain are made in code when the game starts, with no image files. The menus, lessons and coach are regular HTML. The only outside request is the Nunito font from Google Fonts, used where the Apple rounded font is missing.
- The chess rules are written from scratch for this game and checked against the standard "perft" move counts, which catch even rare mistakes. They cover castling, en passant, promotion, check, checkmate, stalemate, threefold repetition, the fifty-move rule and positions where neither side has enough pieces to win.
- The computer looks a few moves ahead, skipping lines that are already worse than one it has found, then follows any captures until the position is calm. The lower levels add random noise and the odd random move, so they make the kind of mistakes people make. It thinks in a background worker, so the board never freezes. If the browser blocks the worker, it thinks on the page instead.
- The coach reads each move from the position: checkmate, check, promotion and captures first, then threats like forks, then good opening habits. After every move it also checks your pieces and warns you about any that can be taken for free, or by something worth less.
- The pieces are turned on a lathe in code, from a side profile, like real wooden pieces. The knight is carved instead: a side profile, thickened, then narrowed toward the muzzle and ears.
- Sounds are made with the Web Audio API and start after your first key press or tap.
- Your finished lessons, your sound choice and the last level and side you picked are kept in `localStorage` under `knight-school-v1`. Nothing leaves your browser.
- Motion is reduced when your device asks for reduced motion.

## License

Knight School is free and open source under the [MIT License](LICENSE). Anyone, schools included, can use it, change it and share it, as long as they keep the license file with it. It includes three.js, which is also under the MIT License; its notice is at the top of `src/three.min.js`.

Made by Ansu Badjie.
