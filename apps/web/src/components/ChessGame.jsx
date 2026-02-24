import { useMemo } from 'react';
import { Chessboard } from 'react-chessboard';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function ChessGame({ fen, orientation, canMove, onMove, theme = 'light' }) {
  const boardId = useMemo(() => `board-${Math.random().toString(36).slice(2)}`, []);
  const safePosition = fen === 'start' ? START_FEN : fen;
  const palette = useMemo(
    () =>
      theme === 'dark'
        ? {
            light: '#f8f2fa',
            dark: '#d74284'
          }
        : {
            light: '#fff9fe',
            dark: '#e54486'
          },
    [theme]
  );
  const files = orientation === 'black'
    ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']
    : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ranks = orientation === 'black'
    ? ['1', '2', '3', '4', '5', '6', '7', '8']
    : ['8', '7', '6', '5', '4', '3', '2', '1'];

  const options = useMemo(
    () => ({
      id: boardId,
      position: safePosition,
      boardOrientation: orientation === 'black' ? 'black' : 'white',
      allowDragging: canMove,
      onPieceDrop: ({ sourceSquare, targetSquare }) => onMove(sourceSquare, targetSquare),
      showNotation: false,
      lightSquareStyle: { backgroundColor: palette.light },
      darkSquareStyle: { backgroundColor: palette.dark },
      alphaNotationStyle: { fontSize: 0, color: 'transparent' },
      numericNotationStyle: { fontSize: 0, color: 'transparent' },
      boardStyle: {
        borderRadius: '8px',
        boxShadow: '0 8px 20px rgba(33, 12, 24, 0.25)'
      }
    }),
    [boardId, safePosition, orientation, canMove, onMove, palette]
  );

  return (
    <div className="chess-shell">
      <div className="chess-ranks" aria-hidden="true">
        {ranks.map((rank) => (
          <span key={rank}>{rank}</span>
        ))}
      </div>
      <div className="chess-board-core">
        <Chessboard options={options} />
      </div>
      <div className="chess-files" aria-hidden="true">
        {files.map((file) => (
          <span key={file}>{file}</span>
        ))}
      </div>
    </div>
  );
}
