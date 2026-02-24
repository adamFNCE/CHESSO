import { useEffect, useMemo, useRef, useState } from 'react';
import { ChessGame } from './components/ChessGame.jsx';
import { connectUniversalProfile } from './lib.wallet.js';
import {
  createEscrowMatch,
  lockEscrowStake,
  settleEscrowMatch,
  readEscrowMatch,
  refundExpiredStake,
  preFundLsp7Stake,
  deployStakeEscrow
} from './lib.escrow.js';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080';
const APP_URL = import.meta.env.VITE_APP_URL || '';
const ESCROW_ADDRESS = import.meta.env.VITE_ESCROW_ADDRESS || '';
const POTATO_TOKEN_ADDRESS = import.meta.env.VITE_POTATO_TOKEN_ADDRESS || '';
const CHESS_TOKEN_ADDRESS = import.meta.env.VITE_CHESS_TOKEN_ADDRESS || '0x2Bce0fD47ea6447e257925fdb14bDC9d5AA18d22';
const FEE_RECIPIENT_ADDRESS = import.meta.env.VITE_FEE_RECIPIENT_ADDRESS || '0x6230143Fe178d1C790748cFB03C544166Bf0c86a';
const PROTOCOL_FEE_BPS = Number(import.meta.env.VITE_PROTOCOL_FEE_BPS || 500);
const STAKING_ENABLED_DEFAULT = String(import.meta.env.VITE_STAKING_ENABLED || 'false').toLowerCase() === 'true';
const isHexAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(value || '');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function resolveWinnerAddress(game) {
  if (!game?.result) return null;
  if (game.result.startsWith('white_wins')) return game.players?.white || null;
  if (game.result.startsWith('black_wins')) return game.players?.black || null;
  return null;
}

function formatMs(ms) {
  const safe = Math.max(0, Math.floor((ms || 0) / 1000));
  const min = String(Math.floor(safe / 60)).padStart(2, '0');
  const sec = String(safe % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function formatChatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function shortenAddress(address) {
  if (!address || address.length < 10) return address || '-';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function resolveShareBaseUrl() {
  const configured = String(APP_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

function isAiAddress(address) {
  return typeof address === 'string' && address.startsWith('ai:');
}

export default function App() {
  const [walletProvider, setWalletProvider] = useState(null);
  const [account, setAccount] = useState('');
  const [profile, setProfile] = useState({ username: '', avatar: '' });
  const [isWalletConnecting, setIsWalletConnecting] = useState(false);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState('light');
  const [showWelcome, setShowWelcome] = useState(true);
  const [roomId, setRoomId] = useState('');
  const [pendingRoom, setPendingRoom] = useState('');
  const [game, setGame] = useState(null);
  const [connected, setConnected] = useState(false);
  const [stakeToken, setStakeToken] = useState(CHESS_TOKEN_ADDRESS ? 'chess' : 'native');
  const [stakeAmount, setStakeAmount] = useState('0.1');
  const [stakingEnabled, setStakingEnabled] = useState(STAKING_ENABLED_DEFAULT);
  const [escrowAddress, setEscrowAddress] = useState(ESCROW_ADDRESS);
  const [lsp7Asset, setLsp7Asset] = useState(POTATO_TOKEN_ADDRESS || CHESS_TOKEN_ADDRESS);
  const [txStatus, setTxStatus] = useState('');
  const [escrowState, setEscrowState] = useState(null);
  const [chatDraft, setChatDraft] = useState('');
  const [activityItems, setActivityItems] = useState([]);
  const [incomingOffer, setIncomingOffer] = useState(null);
  const [showIncomingOfferModal, setShowIncomingOfferModal] = useState(false);
  const [acceptingOffer, setAcceptingOffer] = useState(false);
  const [creatingOffer, setCreatingOffer] = useState(false);
  const [deployingEscrow, setDeployingEscrow] = useState(false);
  const [showAiLevelModal, setShowAiLevelModal] = useState(false);
  const [isFreeInvite, setIsFreeInvite] = useState(false);
  const [leaderboardFilter, setLeaderboardFilter] = useState('stakes');
  const [preFundedByRoom, setPreFundedByRoom] = useState({});
  const [offerProgress, setOfferProgress] = useState({ open: false, title: '', detail: '' });
  const [endgameModal, setEndgameModal] = useState({ open: false, isWinner: false, title: '', detail: '' });
  const [payoutProcessing, setPayoutProcessing] = useState(false);

  const wsRef = useRef(null);
  const gameRef = useRef(null);
  const roomRef = useRef('');
  const reconnectTimerRef = useRef(null);
  const shouldReconnectRef = useRef(true);
  const shownResultKeyRef = useRef('');

  const playerColor = useMemo(() => {
    if (!game || !account) return 'white';
    if (game.players?.white === account.toLowerCase()) return 'white';
    if (game.players?.black === account.toLowerCase()) return 'black';
    if (
      incomingOffer &&
      roomId === incomingOffer.roomId &&
      game.players?.white &&
      game.players.white !== account.toLowerCase()
    ) {
      return 'black';
    }
    return 'white';
  }, [account, game, incomingOffer, roomId]);

  const myColor = useMemo(() => {
    if (!game || !account) return null;
    if (game.players?.white === account.toLowerCase()) return 'white';
    if (game.players?.black === account.toLowerCase()) return 'black';
    if (
      incomingOffer &&
      roomId === incomingOffer.roomId &&
      game.players?.white &&
      game.players.white !== account.toLowerCase()
    ) {
      return 'black';
    }
    return null;
  }, [account, game, incomingOffer, roomId]);

  const canMove =
    !!game &&
    account &&
    ((game.turn === 'w' && game.players?.white === account.toLowerCase()) ||
      (game.turn === 'b' && game.players?.black === account.toLowerCase())) &&
    !game.finished;

  const winnerAddress = resolveWinnerAddress(game);
  const hasTwoPlayers = Boolean(game?.players?.white && game?.players?.black);
  const escrowConfigured = isHexAddress(escrowAddress);
  const selectedLsp7Asset = stakeToken === 'potato'
    ? POTATO_TOKEN_ADDRESS
    : stakeToken === 'chess'
      ? CHESS_TOKEN_ADDRESS
      : lsp7Asset;
  const assetType = stakeToken === 'native' ? 'native' : 'lsp7';
  const lsp7Configured = stakeToken === 'native' ? true : isHexAddress(selectedLsp7Asset);
  const canStakeNow = Boolean(account && roomId && hasTwoPlayers && escrowConfigured);
  const drawOfferedByOpponent = Boolean(game?.drawOfferBy && myColor && game.drawOfferBy !== myColor);
  const canOfferRematch = Boolean(game?.finished && myColor);
  const rematchOfferedByMe = Boolean(myColor && game?.rematchOffers?.includes(myColor));
  const myChatMember = account ? game?.chat?.members?.[account] : null;
  const myChatUsername =
    typeof myChatMember === 'string' ? myChatMember : (myChatMember?.username || profile.username || '');
  const myChatAvatar =
    typeof myChatMember === 'string' ? profile.avatar : (myChatMember?.avatar || profile.avatar || '');
  const chatMessages = game?.chat?.messages || [];
  const isStakeAmountValid = Number.isFinite(Number(stakeAmount || '0')) && Number(stakeAmount || '0') > 0;
  const canCreateOfferInputReady =
    isStakeAmountValid &&
    escrowConfigured &&
    (assetType !== 'lsp7' || lsp7Configured);
  const stakeAssetLabel = stakeToken === 'native'
    ? 'LYX'
    : stakeToken === 'chess'
      ? '$CHESS'
      : '$POTATOE';
  const leaderboardRows = [
    { rank: 1, name: 'UP_Grandmaster', wins: 42, elo: 2135, mode: 'stakes', difficulty: '-' },
    { rank: 2, name: 'Frozeman', wins: 36, elo: 2068, mode: 'stakes', difficulty: '-' },
    { rank: 3, name: 'StreetKnight', wins: 27, elo: 1964, mode: 'free', difficulty: '-' },
    { rank: 4, name: 'PawnRunner', wins: 24, elo: 1910, mode: 'free', difficulty: '-' },
    { rank: 5, name: 'BotCrusher', wins: 19, elo: 1885, mode: 'ai', difficulty: 'Master' },
    { rank: 6, name: 'KnightHacker', wins: 15, elo: 1804, mode: 'ai', difficulty: 'Hard' },
    { rank: 7, name: 'CasualUP', wins: 11, elo: 1722, mode: 'ai', difficulty: 'Intermediate' },
    { rank: 8, name: 'NewbieMate', wins: 8, elo: 1610, mode: 'ai', difficulty: 'Beginner' }
  ];
  const filteredLeaderboardRows = leaderboardRows.filter((row) => row.mode === leaderboardFilter);
  const whiteAddress = game?.players?.white || '';
  const blackAddress = game?.players?.black || '';
  const whiteMember = whiteAddress ? game?.chat?.members?.[whiteAddress] : null;
  const blackMember = blackAddress ? game?.chat?.members?.[blackAddress] : null;
  const whiteName = whiteAddress
    ? (whiteAddress === account && profile.username) ||
      (whiteMember && typeof whiteMember === 'object' ? whiteMember.username : '') ||
      (whiteMember && typeof whiteMember === 'string' ? whiteMember : '') ||
      shortenAddress(whiteAddress)
    : 'Waiting for player';
  const blackName = blackAddress
    ? isAiAddress(blackAddress)
      ? `AI (${String(game?.ai?.level || 'Beginner').replace(/^./, (c) => c.toUpperCase())})`
      : (blackAddress === account && profile.username) ||
        (blackMember && typeof blackMember === 'object' ? blackMember.username : '') ||
        (blackMember && typeof blackMember === 'string' ? blackMember : '') ||
        shortenAddress(blackAddress)
    : 'Waiting for player';
  const whiteOnline = Boolean(game?.connection?.whiteOnline && whiteAddress);
  const blackOnline = Boolean(game?.connection?.blackOnline && blackAddress);
  const whiteAvatar = whiteAddress
    ? (whiteAddress === account && profile.avatar) ||
      (whiteMember && typeof whiteMember === 'object' ? whiteMember.avatar : '') ||
      `https://api.dicebear.com/9.x/identicon/svg?seed=${whiteAddress}`
    : 'https://api.dicebear.com/9.x/identicon/svg?seed=waiting-white';
  const blackAvatar = blackAddress
    ? isAiAddress(blackAddress)
      ? `https://api.dicebear.com/9.x/bottts/svg?seed=${game?.ai?.level || 'ai'}`
      : (blackAddress === account && profile.avatar) ||
        (blackMember && typeof blackMember === 'object' ? blackMember.avatar : '') ||
        `https://api.dicebear.com/9.x/identicon/svg?seed=${blackAddress}`
    : 'https://api.dicebear.com/9.x/identicon/svg?seed=waiting-black';

  const addActivity = (entry) => {
    setActivityItems((prev) => [
      { id: `${Date.now()}-${Math.random()}`, at: Date.now(), ...entry },
      ...prev
    ].slice(0, 20));
  };

  const offerShareLink = useMemo(() => {
    const baseUrl = resolveShareBaseUrl();
    if (!roomId || !baseUrl) return '';
    const params = new URLSearchParams({
      offer: '1',
      room: roomId,
      stake: stakeAmount || '0',
      token: stakeToken
    });
    if (account) params.set('white', account);
    if (escrowConfigured) params.set('escrow', escrowAddress);
    return `${baseUrl}/?${params.toString()}`;
  }, [roomId, stakeAmount, stakeToken, escrowConfigured, escrowAddress, account]);

  useEffect(() => {
    const storedTheme = localStorage.getItem('chesso-theme');
    if (storedTheme === 'dark' || storedTheme === 'light') {
      setTheme(storedTheme);
    }
    const storedStaking = localStorage.getItem('chesso-staking-enabled');
    if (storedStaking === 'true' || storedStaking === 'false') {
      setStakingEnabled(storedStaking === 'true');
    }
    const storedEscrowAddress = localStorage.getItem('chesso-escrow-address');
    if (storedEscrowAddress) setEscrowAddress(storedEscrowAddress);
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const room = params.get('room');
      const stake = params.get('stake');
      const token = params.get('token');
      const escrow = params.get('escrow');
      const white = params.get('white');
      const isOffer = params.get('offer') === '1';
      const isFree = params.get('free') === '1';
      if (room) setPendingRoom(room);
      if (isFree && room) setIsFreeInvite(true);
      if (stake) setStakeAmount(stake);
      if (token === 'native' || token === 'potato' || token === 'chess') {
        setStakeToken(token);
      }
      if (escrow && isHexAddress(escrow)) setEscrowAddress(escrow);
      if (isOffer && room && stake && (token === 'native' || token === 'potato' || token === 'chess')) {
        setIncomingOffer({
          roomId: room,
          stakeAmount: stake,
          token,
          white: white ? white.toLowerCase() : '',
          escrow: escrow && isHexAddress(escrow) ? escrow : ''
        });
        setShowIncomingOfferModal(true);
      }
    }
  }, []);

  useEffect(() => {
    if (stakeToken === 'potato') {
      setLsp7Asset(POTATO_TOKEN_ADDRESS);
      return;
    }
    if (stakeToken === 'chess') {
      setLsp7Asset(CHESS_TOKEN_ADDRESS);
    }
  }, [stakeToken]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('chesso-theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('chesso-staking-enabled', String(stakingEnabled));
  }, [stakingEnabled]);

  useEffect(() => {
    localStorage.setItem('chesso-escrow-address', escrowAddress || '');
  }, [escrowAddress]);

  useEffect(() => {
    if (!account || !roomId || !profile.username) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (myChatUsername === profile.username && (myChatAvatar || '') === (profile.avatar || '')) return;

    wsRef.current.send(
      JSON.stringify({
        type: 'enter_chat',
        payload: {
          roomId,
          address: account,
          username: profile.username,
          avatar: profile.avatar || ''
        }
      })
    );
  }, [account, roomId, profile.username, profile.avatar, myChatUsername, myChatAvatar]);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    roomRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    if (!game?.finished || !game?.result || !account) return;
    const resultKey = `${game.id}:${game.result}:${account}`;
    if (shownResultKeyRef.current === resultKey) return;
    shownResultKeyRef.current = resultKey;

    const winner = resolveWinnerAddress(game);
    const amWinner = Boolean(winner && winner === account);
    setEndgameModal({
      open: true,
      isWinner: amWinner,
      title: amWinner ? 'Victory' : 'Defeat',
      detail: amWinner
        ? 'You won this match. Claim payout to settle escrow and receive winnings.'
        : 'Game finished. Better luck in the next match.'
    });

    if (walletProvider && escrowConfigured && roomId) {
      void readEscrowMatch({ walletProvider, escrowAddress, roomId })
        .then((state) => setEscrowState(state))
        .catch(() => {});
    }
  }, [game?.finished, game?.result, game?.id, account, walletProvider, escrowConfigured, escrowAddress, roomId]);

  useEffect(() => {
    if (!game?.finished) {
      setEndgameModal((prev) => (prev.open ? { open: false, isWinner: false, title: '', detail: '' } : prev));
    }
  }, [game?.finished]);

  useEffect(() => {
    shouldReconnectRef.current = true;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onclose = () => {
        setConnected(false);
        if (!shouldReconnectRef.current) return;
        reconnectTimerRef.current = setTimeout(connect, 1000);
      };

      ws.onerror = () => {
        setConnected(false);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'game_state') {
            setGame(message.payload);
            setRoomId(message.payload.id);
            setShowWelcome(false);
          }
          if (message.type === 'error') {
            setError(message.message || 'Unknown server error');
          }
        } catch {
          setError('Invalid server message');
        }
      };
    };

    connect();
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  const send = (type, payload = {}) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('Socket not ready');
      return false;
    }
    setError('');
    wsRef.current.send(JSON.stringify({ type, payload }));
    return true;
  };

  const logEscrowAction = ({ action, txHash, transferTxHash }) => {
    if (!account || !roomId) return;
    send('escrow_log', {
      roomId,
      address: account,
      action,
      assetType,
      stakeAmount,
      txHash: txHash || null,
      transferTxHash: transferTxHash || null,
      at: Date.now()
    });
  };

  const onConnectWallet = async () => {
    setIsWalletConnecting(true);
    try {
      setError('');
      const { provider, account: wallet, profile: walletProfile } = await connectUniversalProfile();
      if (!wallet) throw new Error('Wallet returned no account');
      setWalletProvider(provider || window?.lukso || window?.ethereum || null);
      const normalized = wallet.toLowerCase();
      setAccount(normalized);
      if (walletProfile) setProfile(walletProfile);
      return normalized;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setIsWalletConnecting(false);
    }
  };

  const onDisconnect = () => {
    setWalletProvider(null);
    setAccount('');
    setProfile({ username: '', avatar: '' });
    setGame(null);
    setRoomId('');
    setPendingRoom('');
    setEscrowState(null);
    setTxStatus('');
    setChatDraft('');
    setError('');
    setEndgameModal({ open: false, isWinner: false, title: '', detail: '' });
    shownResultKeyRef.current = '';
    setShowWelcome(true);
  };

  const onCreateRoom = () => {
    if (!account) return setError('Connect wallet first');
    setShowWelcome(false);
    send('create_room', { address: account });
  };

  const onJoinRoom = () => {
    if (!account) return setError('Connect wallet first');
    if (!pendingRoom.trim()) return setError('Enter room id');
    setShowWelcome(false);
    send('join_room', { roomId: pendingRoom.trim(), address: account });
  };

  const onMove = (from, to) => {
    send('make_move', { roomId, from, to, address: account });
    return true;
  };

  const onResumeRoom = () => {
    if (!account) return setError('Connect wallet first');
    if (!pendingRoom.trim()) return setError('Enter room id');
    setShowWelcome(false);
    send('resume_room', { roomId: pendingRoom.trim(), address: account });
  };

  const onPlayNow = async () => {
    let player = account;
    if (!player) player = await onConnectWallet();
    if (!player) return;
    setShowWelcome(false);
    if (isFreeInvite && pendingRoom.trim()) {
      send('join_room', { roomId: pendingRoom.trim(), address: player });
      return;
    }
    send('create_room', { address: player });
  };

  const onBackToHome = () => {
    setError('');
    setShowWelcome(true);
  };

  const onToggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const onResign = () => {
    if (!account || !roomId) return setError('Need connected player and room');
    send('resign', { roomId, address: account });
  };

  const onOfferDraw = () => {
    if (!account || !roomId) return setError('Need connected player and room');
    send('offer_draw', { roomId, address: account });
  };

  const onAcceptDraw = () => {
    if (!account || !roomId) return setError('Need connected player and room');
    send('accept_draw', { roomId, address: account });
  };

  const onOfferRematch = () => {
    if (!account || !roomId) return setError('Need connected player and room');
    send('offer_rematch', { roomId, address: account });
  };

  const onSendChat = () => {
    if (!account || !roomId) return setError('Need connected player and room');
    const text = chatDraft.trim();
    if (!text) return;
    send('send_chat', {
      roomId,
      address: account,
      text,
      username: myChatUsername || profile.username || `Player-${account.slice(2, 6)}`,
      avatar: myChatAvatar || profile.avatar || `https://api.dicebear.com/9.x/identicon/svg?seed=${account}`
    });
    setChatDraft('');
  };

  const createEscrowMatchNow = async () => {
    try {
      if (!stakingEnabled) throw new Error('Staking is disabled. Enable "Beta staking" below.');
      if (!walletProvider || !account) throw new Error('Connect wallet first');
      if (!escrowAddress) throw new Error('Set escrow address first');
      if (!roomId || !game?.players?.white || !game?.players?.black) {
        throw new Error('Need an active room with 2 players');
      }
      if (assetType === 'lsp7' && !selectedLsp7Asset) throw new Error('Set LSP7 token address');

      setTxStatus('Creating escrow match...');
      const { txHash } = await createEscrowMatch({
        walletProvider,
        escrowAddress,
        roomId,
        white: game.players.white,
        black: game.players.black,
        stakeAmount,
        assetType,
        lsp7Asset: selectedLsp7Asset
      });
      setTxStatus(`Match created: ${txHash}`);
      logEscrowAction({ action: 'create_match', txHash });
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  const runCreateOffer = async () => {
    if (!walletProvider || !account) throw new Error('Connect wallet first');
    if (!roomId) throw new Error('Create or join a room first');
    if (!isStakeAmountValid) throw new Error('Set valid stake amount');
    if (!escrowConfigured) throw new Error('Set escrow contract address in staking settings.');
    if (assetType === 'lsp7' && !lsp7Configured) throw new Error(`Missing token address for ${stakeAssetLabel}.`);

    setError('');

    if (assetType === 'lsp7' && !preFundedByRoom[roomId]) {
      setTxStatus('Creating offer: transfer stake to escrow...');
      setTxStatus('Waiting for wallet approval...');
      const { txHash } = await preFundLsp7Stake({
        walletProvider,
        escrowAddress,
        stakeAmount,
        lsp7Asset: selectedLsp7Asset,
        playerAddress: account
      });
      setPreFundedByRoom((prev) => ({ ...prev, [roomId]: true }));
      addActivity({
        kind: 'prefund',
        title: 'Stake transferred',
        detail: `${stakeAmount} ${stakeAssetLabel} sent to escrow`,
        txHash
      });
    }

    addActivity({
      kind: 'offer',
      title: 'Offer created',
      detail: `${stakeAmount} ${stakeAssetLabel} per player`,
      link: offerShareLink
    });

    if (!hasTwoPlayers) {
      if (assetType === 'native') {
        throw new Error('Opponent must join the room before native LYX can be locked. Share the offer link first.');
      }
      setTxStatus('Offer created. Share link and wait for opponent to join.');
      return;
    }
    if (!stakingEnabled) throw new Error('Enable Beta Staking in staking settings.');
    if (!escrowConfigured) throw new Error('Set escrow contract address in staking settings.');
    if (assetType === 'lsp7' && !lsp7Configured) throw new Error(`Missing token address for ${stakeAssetLabel}.`);

    let state = null;
    try {
      state = await readEscrowMatch({
        walletProvider,
        escrowAddress,
        roomId
      });
      setEscrowState(state);
    } catch {
      state = null;
    }

    const escrowMatchExists =
      Boolean(state?.white) && isHexAddress(state.white) && state.white.toLowerCase() !== ZERO_ADDRESS;

    if (!escrowMatchExists) {
      const created = await createEscrowMatchNow();
      if (!created) return;
      addActivity({
        kind: 'created',
        title: 'Escrow created',
        detail: `${stakeAmount} ${stakeAssetLabel} match funded flow started`,
        link: offerShareLink
      });
      state = await onRefreshEscrow();
    }

    const isWhite = game?.players?.white === account;
    const isBlack = game?.players?.black === account;
    const alreadyLocked = isWhite ? state?.whiteLocked : isBlack ? state?.blackLocked : false;
    if (alreadyLocked) {
      setTxStatus('Offer is live. Your stake is already locked.');
      return;
    }

    await onLockStake(preFundedByRoom[roomId] === true);
    await onRefreshEscrow();
  };

  const waitForSocketReady = async (timeoutMs = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (wsRef.current?.readyState === WebSocket.OPEN) return true;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return false;
  };

  const onCreateOffer = () => {
    const run = async () => {
      setCreatingOffer(true);
      setOfferProgress({
        open: true,
        title: 'Preparing Offer',
        detail: 'Connecting wallet and lobby...'
      });
      let player = account;
      if (!player) {
        setOfferProgress({
          open: true,
          title: 'Connecting Wallet',
          detail: 'Approve connection in your Universal Profile wallet.'
        });
        player = await onConnectWallet();
      }
      if (!player) return;

      let activeRoomId = roomRef.current;
      if (!activeRoomId) {
        const socketReady = await waitForSocketReady();
        if (!socketReady) throw new Error('Game server is offline. Start server and try again.');
        const requestedRoomId = pendingRoom.trim();
        setShowWelcome(false);

        if (requestedRoomId) {
          setOfferProgress({
            open: true,
            title: 'Joining Room',
            detail: `Joining room ${requestedRoomId}...`
          });
          setTxStatus('Joining room...');
          const sent = send('join_room', { roomId: requestedRoomId, address: player });
          if (!sent) throw new Error('Could not join room because socket is not connected.');
          const joined = await waitForRoomReady(requestedRoomId, 12000);
          if (!joined) {
            throw new Error('Could not join room yet. Check room id and try again.');
          }
          activeRoomId = requestedRoomId;
        } else {
          setOfferProgress({
            open: true,
            title: 'Creating Room',
            detail: 'Creating room automatically...'
          });
          setTxStatus('Creating room...');
          const sent = send('create_room', { address: player });
          if (!sent) throw new Error('Could not create room because socket is not connected.');
          const created = await waitForRoomReady(null, 12000);
          if (!created?.id) {
            throw new Error('Room creation timed out. Try again.');
          }
          activeRoomId = created.id;
        }
      }

      if (!isStakeAmountValid) throw new Error('Set valid stake amount');
      if (!escrowConfigured) throw new Error('Set escrow contract address in staking settings.');
      if (assetType === 'lsp7' && !lsp7Configured) throw new Error(`Missing token address for ${stakeAssetLabel}.`);
      setError('');
      setTxStatus(`Room ready: ${activeRoomId}`);
      setOfferProgress({
        open: true,
        title: 'Creating Offer',
        detail:
          assetType === 'lsp7'
            ? `Waiting for wallet signature: approve ${stakeAssetLabel} transfer to escrow.`
            : 'Approve stake lock transaction in your wallet.'
      });
      await runCreateOffer();
      setOfferProgress({
        open: true,
        title: 'Offer Created',
        detail: 'Stake flow complete. Share link with opponent if needed.'
      });
      setTimeout(() => {
        setOfferProgress({ open: false, title: '', detail: '' });
      }, 1200);
    };

    void run().catch((err) => {
      setError(err.message || 'Could not continue with offer setup');
      setOfferProgress({
        open: true,
        title: 'Create Offer Failed',
        detail: err.message || 'Could not continue with offer setup.'
      });
    }).finally(() => {
      setCreatingOffer(false);
    });
  };

  const onDeployEscrow = () => {
    const run = async () => {
      setDeployingEscrow(true);
      setOfferProgress({
        open: true,
        title: 'Deploying Escrow',
        detail: 'Approve contract deployment in your wallet.'
      });

      let player = account;
      let provider = walletProvider;
      if (!player || !provider) {
        setOfferProgress({
          open: true,
          title: 'Connecting Wallet',
          detail: 'Approve connection in your Universal Profile wallet.'
        });
        player = await onConnectWallet();
        provider = window?.lukso || window?.ethereum || walletProvider;
      }
      if (!player || !provider) throw new Error('Wallet connection required');

      const { escrowAddress: deployedAddress, txHash } = await deployStakeEscrow({
        walletProvider: provider,
        arbiter: player,
        feeRecipient: FEE_RECIPIENT_ADDRESS || player,
        lockWindowSeconds: 900,
        protocolFeeBps: 500
      });

      setEscrowAddress(deployedAddress);
      setTxStatus(txHash ? `Escrow deployed: ${txHash}` : `Escrow deployed: ${deployedAddress}`);
      addActivity({
        kind: 'deploy',
        title: 'Escrow deployed',
        detail: `Escrow ${shortenAddress(deployedAddress)}`,
        txHash: txHash || undefined
      });
      setOfferProgress({
        open: true,
        title: 'Escrow Ready',
        detail: `Deployed ${shortenAddress(deployedAddress)}`
      });
      setTimeout(() => {
        setOfferProgress({ open: false, title: '', detail: '' });
      }, 1200);
    };

    void run().catch((err) => {
      setError(err.message || 'Escrow deployment failed');
      setOfferProgress({
        open: true,
        title: 'Escrow Deployment Failed',
        detail: err.message || 'Escrow deployment failed'
      });
    }).finally(() => {
      setDeployingEscrow(false);
    });
  };

  const onCreateFreePvp = () => {
    const run = async () => {
      let player = account;
      if (!player) player = await onConnectWallet();
      if (!player) return;
      const socketReady = await waitForSocketReady();
      if (!socketReady) throw new Error('Game server is offline. Start server and try again.');

      setOfferProgress({
        open: true,
        title: 'Creating Free PvP',
        detail: 'Creating room and preparing invite link...'
      });
      const sent = send('create_room', { address: player });
      if (!sent) throw new Error('Could not create room because socket is disconnected.');
      const created = await waitForRoomReady(null, 12000);
      const baseUrl = resolveShareBaseUrl();
      if (!created?.id || !baseUrl) {
        throw new Error('Free PvP room creation timed out.');
      }

      const params = new URLSearchParams({ free: '1', room: created.id });
      const freeLink = `${baseUrl}/?${params.toString()}`;
      await navigator.clipboard.writeText(freeLink);

      addActivity({
        kind: 'free_pvp',
        title: 'Free PvP room created',
        detail: `Room ${created.id} ready. Invite link copied.`,
        link: freeLink
      });
      setTxStatus('Free PvP link copied');
      setOfferProgress({
        open: true,
        title: 'Free PvP Ready',
        detail: 'Invite link copied to clipboard.'
      });
      setTimeout(() => {
        setOfferProgress({ open: false, title: '', detail: '' });
      }, 1200);
    };

    void run().catch((err) => {
      setError(err.message || 'Could not create free PvP room');
      setOfferProgress({
        open: true,
        title: 'Free PvP Failed',
        detail: err.message || 'Could not create free PvP room'
      });
    });
  };

  const onStartAiLevel = (level) => {
    const run = async () => {
      setShowAiLevelModal(false);
      setOfferProgress({
        open: true,
        title: 'Starting AI Match',
        detail: `Creating room and enabling ${level} AI...`
      });

      let player = account;
      if (!player) {
        setOfferProgress({
          open: true,
          title: 'Connecting Wallet',
          detail: 'Approve connection in your Universal Profile wallet.'
        });
        player = await onConnectWallet();
      }
      if (!player) return;

      const socketReady = await waitForSocketReady();
      if (!socketReady) throw new Error('Game server socket is not ready. Refresh and retry.');

      setShowWelcome(false);
      const createdSent = send('create_room', { address: player });
      if (!createdSent) throw new Error('Could not create room because socket is disconnected.');
      const created = await waitForRoomReady(null, 12000);
      if (!created?.id) throw new Error('AI room creation timed out.');

      const aiSent = send('set_ai_level', {
        roomId: created.id,
        address: player,
        level
      });
      if (!aiSent) throw new Error('Could not configure AI level because socket is disconnected.');

      const aiReady = await waitForAiReady(created.id, level, 8000);
      if (!aiReady) throw new Error('AI setup timed out.');

      setTxStatus(`AI ${level} room ready`);
      addActivity({
        kind: 'ai',
        title: `AI match created (${level})`,
        detail: `Room ${created.id} ready. You play white; AI plays black.`
      });
      setOfferProgress({
        open: true,
        title: 'AI Match Ready',
        detail: `${level} AI enabled. Make your first move.`
      });
      setTimeout(() => {
        setOfferProgress({ open: false, title: '', detail: '' });
      }, 1200);
    };

    void run().catch((err) => {
      setError(err.message || 'Could not start AI match');
      setOfferProgress({
        open: true,
        title: 'AI Setup Failed',
        detail: err.message || 'Could not start AI match'
      });
    });
  };

  const waitForRoomReady = async (targetRoomId, timeoutMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = gameRef.current;
      if (!targetRoomId && current?.id) {
        return current;
      }
      if (targetRoomId && current?.id === targetRoomId) {
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  };

  const waitForRoomPlayers = async (targetRoomId, timeoutMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = gameRef.current;
      if (current?.id === targetRoomId && current.players?.white && current.players?.black) {
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  };

  const waitForAiReady = async (targetRoomId, level, timeoutMs = 8000) => {
    const start = Date.now();
    const normalized = String(level || '').toLowerCase();
    while (Date.now() - start < timeoutMs) {
      const current = gameRef.current;
      if (
        current?.id === targetRoomId &&
        current.ai?.enabled &&
        String(current.ai?.level || '').toLowerCase() === normalized
      ) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  };

  const onAcceptIncomingOffer = async () => {
    if (!incomingOffer) return;
    setAcceptingOffer(true);
    try {
      setShowIncomingOfferModal(false);
      setOfferProgress({
        open: true,
        title: 'Accepting Offer',
        detail: 'Preparing stake transaction...'
      });
      const offerToken = incomingOffer.token || 'native';
      const offerAssetType = offerToken === 'native' ? 'native' : 'lsp7';
      const offerLsp7Asset = offerToken === 'potato'
        ? POTATO_TOKEN_ADDRESS
        : offerToken === 'chess'
          ? CHESS_TOKEN_ADDRESS
          : lsp7Asset;
      const offerCreator = String(incomingOffer.white || '').toLowerCase();

      let activeWalletProvider = walletProvider || window?.lukso || window?.ethereum || null;
      let player = account;
      if (!player) {
        player = await onConnectWallet();
        activeWalletProvider = window?.lukso || window?.ethereum || activeWalletProvider;
      }
      if (!player) throw new Error('Wallet connection required');
      if (!activeWalletProvider) throw new Error('Wallet provider unavailable');

      const activeEscrowAddress =
        incomingOffer.escrow && isHexAddress(incomingOffer.escrow) ? incomingOffer.escrow : escrowAddress;
      if (incomingOffer.token) setStakeToken(incomingOffer.token);
      if (incomingOffer.stakeAmount) setStakeAmount(incomingOffer.stakeAmount);
      if (incomingOffer.escrow && isHexAddress(incomingOffer.escrow)) setEscrowAddress(incomingOffer.escrow);
      if (!isHexAddress(activeEscrowAddress)) {
        throw new Error('Offer escrow address is invalid.');
      }
      if (offerCreator && player === offerCreator) {
        throw new Error('Use a different wallet than the offer creator to accept.');
      }

      if (!stakingEnabled) throw new Error('Enable Beta Staking in staking settings.');
      if (!isHexAddress(activeEscrowAddress)) throw new Error('Escrow contract address is required in staking settings.');
      if (offerAssetType === 'lsp7' && !isHexAddress(offerLsp7Asset)) {
        throw new Error(`Missing token address for ${stakeAssetLabel}.`);
      }

      let state = null;
      try {
        state = await readEscrowMatch({
          walletProvider: activeWalletProvider,
          escrowAddress: activeEscrowAddress,
          roomId: incomingOffer.roomId
        });
        setEscrowState(state);
      } catch {
        state = null;
      }

      const escrowMatchExists =
        Boolean(state?.white) && isHexAddress(state.white) && state.white.toLowerCase() !== ZERO_ADDRESS;

      if (!escrowMatchExists) {
        if (!offerCreator || !isHexAddress(offerCreator)) {
          throw new Error('Offer missing creator address. Ask host to create a new offer link.');
        }
        setTxStatus('Creating escrow match...');
        setOfferProgress({
          open: true,
          title: 'Creating Escrow Match',
          detail: 'Confirm escrow match creation in wallet.'
        });
        try {
          const { txHash } = await createEscrowMatch({
            walletProvider: activeWalletProvider,
            escrowAddress: activeEscrowAddress,
            roomId: incomingOffer.roomId,
            white: offerCreator,
            black: player,
            stakeAmount: incomingOffer.stakeAmount,
            assetType: offerAssetType,
            lsp7Asset: offerLsp7Asset
          });
          logEscrowAction({ action: 'create_match', txHash });
        } catch (createErr) {
          // If match already exists, continue to lock flow instead of aborting.
          let fallbackState = null;
          try {
            fallbackState = await readEscrowMatch({
              walletProvider: activeWalletProvider,
              escrowAddress: activeEscrowAddress,
              roomId: incomingOffer.roomId
            });
          } catch {
            fallbackState = null;
          }
          const existsAfterCreateFailure =
            Boolean(fallbackState?.white) &&
            isHexAddress(fallbackState.white) &&
            fallbackState.white.toLowerCase() !== ZERO_ADDRESS;
          if (!existsAfterCreateFailure) {
            throw createErr;
          }
          setEscrowState(fallbackState);
        }
      }

      setTxStatus('Accepting offer: locking stake...');
      setOfferProgress({
        open: true,
        title: 'Stake Transfer',
        detail:
          offerAssetType === 'lsp7'
            ? `Approve ${incomingOffer.stakeAmount} ${incomingOfferAssetLabel} transfer to escrow in wallet.`
            : `Approve ${incomingOffer.stakeAmount} LYX lock transaction in wallet.`
      });
      const { txHash, transferTxHash } = await lockEscrowStake({
        walletProvider: activeWalletProvider,
        escrowAddress: activeEscrowAddress,
        roomId: incomingOffer.roomId,
        stakeAmount: incomingOffer.stakeAmount,
        assetType: offerAssetType,
        lsp7Asset: offerLsp7Asset,
        playerAddress: player
      });
      setTxStatus(`Stake locked: ${txHash}`);
      logEscrowAction({ action: 'lock_stake', txHash, transferTxHash });
      addActivity({
        kind: 'accepted',
        title: 'Offer accepted',
        detail: `${shortenAddress(player)} locked ${incomingOffer.stakeAmount} ${incomingOfferAssetLabel}`,
        txHash
      });

      const socketReady = await waitForSocketReady();
      if (!socketReady) throw new Error('Game server socket is not ready. Refresh and retry.');
      setOfferProgress({
        open: true,
        title: 'Joining Room',
        detail: 'Stake approved. Joining room as black...'
      });
      setShowWelcome(false);
      setPendingRoom(incomingOffer.roomId);
      const sent = send('join_room', { roomId: incomingOffer.roomId, address: player });
      if (!sent) throw new Error('Could not join room because socket is disconnected.');

      const joinedGame = await waitForRoomReady(incomingOffer.roomId, 12000);
      if (!joinedGame) {
        throw new Error('Stake locked, but room join timed out. Refresh and re-open invite link.');
      }
      if (joinedGame.players?.black && joinedGame.players.black !== player) {
        throw new Error('Room seat mismatch after locking stake. Ask host to create a new offer.');
      }

      const refreshed = await readEscrowMatch({
        walletProvider: activeWalletProvider,
        escrowAddress: activeEscrowAddress,
        roomId: incomingOffer.roomId
      });
      setEscrowState(refreshed);
      setRoomId(incomingOffer.roomId);
      setOfferProgress({
        open: true,
        title: 'Match Ready',
        detail: 'Stake is locked. You are now in the match as black.'
      });
      setTimeout(() => {
        setOfferProgress({ open: false, title: '', detail: '' });
      }, 1200);
    } catch (err) {
      setError(err.message);
      setOfferProgress({
        open: true,
        title: 'Accept Offer Failed',
        detail: err.message || 'Could not accept offer.'
      });
      setShowIncomingOfferModal(true);
    } finally {
      setAcceptingOffer(false);
    }
  };

  const onLockStake = async (skipTransfer = false) => {
    try {
      if (!stakingEnabled) throw new Error('Staking is disabled. Enable "Beta staking" below.');
      if (!walletProvider || !account) throw new Error('Connect wallet first');
      if (!escrowAddress) throw new Error('Set escrow address first');
      if (!roomId) throw new Error('No room selected');
      if (assetType === 'lsp7' && !isHexAddress(selectedLsp7Asset)) throw new Error('Set valid LSP7 token address');

      setTxStatus('Locking stake...');
      const { txHash, transferTxHash } = await lockEscrowStake({
        walletProvider,
        escrowAddress,
        roomId,
        stakeAmount,
        assetType,
        lsp7Asset: selectedLsp7Asset,
        playerAddress: account,
        skipLsp7Transfer: assetType === 'lsp7' && skipTransfer
      });
      setTxStatus(`Stake locked: ${txHash}`);
      logEscrowAction({ action: 'lock_stake', txHash, transferTxHash });
      addActivity({
        kind: 'locked',
        title: 'Stake locked',
        detail: `${shortenAddress(account)} locked ${stakeAmount} ${stakeAssetLabel}`,
        txHash
      });
      if (skipTransfer) {
        setPreFundedByRoom((prev) => ({ ...prev, [roomId]: false }));
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const onSettleEscrow = async () => {
    try {
      if (!stakingEnabled) throw new Error('Staking is disabled. Enable "Beta staking" below.');
      if (!walletProvider || !account) throw new Error('Connect wallet first');
      if (!escrowAddress) throw new Error('Set escrow address first');
      if (!roomId) throw new Error('No room selected');
      if (!winnerAddress) throw new Error('Winner not available yet');

      setTxStatus('Settling escrow...');
      const { txHash } = await settleEscrowMatch({
        walletProvider,
        escrowAddress,
        roomId,
        winner: winnerAddress
      });
      setTxStatus(`Escrow settled: ${txHash}`);
      logEscrowAction({ action: 'settle', txHash });
      addActivity({
        kind: 'settled',
        title: 'Match settled',
        detail: `${shortenAddress(winnerAddress)} won`,
        txHash
      });
      return txHash;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };

  const onRefreshEscrow = async () => {
    try {
      if (!walletProvider || !account) throw new Error('Connect wallet first');
      if (!escrowAddress) throw new Error('Set escrow address first');
      if (!roomId) throw new Error('No room selected');

      const state = await readEscrowMatch({
        walletProvider,
        escrowAddress,
        roomId
      });
      setEscrowState(state);
      return state;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };

  const onClaimWinnerPayout = async () => {
    setPayoutProcessing(true);
    try {
      const txHash = await onSettleEscrow();
      if (!txHash) return;
      await onRefreshEscrow();
      setEndgameModal((prev) => ({
        ...prev,
        detail: `Payout settled. Tx: ${shortenAddress(txHash)}`
      }));
    } finally {
      setPayoutProcessing(false);
    }
  };

  const onRefundStake = async () => {
    try {
      if (!stakingEnabled) throw new Error('Staking is disabled. Enable "Beta staking" below.');
      if (!walletProvider || !account) throw new Error('Connect wallet first');
      if (!escrowAddress) throw new Error('Set escrow address first');
      if (!roomId) throw new Error('No room selected');

      setTxStatus('Requesting stake refund...');
      const { txHash } = await refundExpiredStake({
        walletProvider,
        escrowAddress,
        roomId
      });
      setTxStatus(`Stake refunded: ${txHash}`);
      logEscrowAction({ action: 'refund', txHash });
      addActivity({
        kind: 'refund',
        title: 'Stake refunded',
        detail: `${shortenAddress(account)} refunded`,
        txHash
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const incomingOfferAssetLabel = incomingOffer?.token === 'native'
    ? 'LYX'
    : incomingOffer?.token === 'chess'
      ? '$CHESS'
      : '$POTATOE';
  const incomingStakeValue = Number(incomingOffer?.stakeAmount || '0');
  const incomingPot = Number.isFinite(incomingStakeValue) ? incomingStakeValue * 2 : 0;
  const incomingFee = incomingPot * (PROTOCOL_FEE_BPS / 10000);
  const incomingWinnerPayout = incomingPot - incomingFee;

  const incomingOfferModal =
    showIncomingOfferModal && incomingOffer ? (
      <div className="offer-modal-overlay" role="dialog" aria-modal="true" aria-label="Incoming stake offer">
        <div className="offer-modal">
          <h3>Incoming Match Offer</h3>
          <div className="offer-grid">
            <div>Room</div><div>{incomingOffer.roomId}</div>
            <div>Creator</div><div>{incomingOffer.white ? shortenAddress(incomingOffer.white) : 'unknown'}</div>
            <div>Stake</div><div>{incomingOffer.stakeAmount} {incomingOfferAssetLabel} per player</div>
            <div>Token</div><div>{incomingOfferAssetLabel}</div>
            <div>Escrow</div><div>{incomingOffer.escrow ? shortenAddress(incomingOffer.escrow) : (escrowConfigured ? shortenAddress(escrowAddress) : 'not set')}</div>
            <div>Total Pot</div><div>{incomingPot.toFixed(4)} {incomingOfferAssetLabel}</div>
            <div>Protocol Fee</div><div>{(PROTOCOL_FEE_BPS / 100).toFixed(2)}% ({incomingFee.toFixed(4)} {incomingOfferAssetLabel})</div>
            <div>Winner Payout</div><div>{incomingWinnerPayout.toFixed(4)} {incomingOfferAssetLabel}</div>
            <div>Fee Wallet</div><div>{shortenAddress(FEE_RECIPIENT_ADDRESS)}</div>
          </div>
          <p className="meta small">Accepting will join this room and prompt the stake transfer/lock transaction.</p>
          <div className="offer-modal-actions">
            <button className="ghost-btn" onClick={() => setShowIncomingOfferModal(false)}>Close</button>
            <button onClick={onAcceptIncomingOffer} disabled={acceptingOffer}>
              {acceptingOffer ? 'Accepting...' : 'Accept Offer'}
            </button>
          </div>
        </div>
      </div>
    ) : null;

  const canClaimPayout =
    endgameModal.isWinner &&
    stakingEnabled &&
    escrowConfigured &&
    winnerAddress === account &&
    Boolean(escrowState) &&
    !escrowState?.settled &&
    !escrowState?.cancelled;

  const endgameResultModal =
    endgameModal.open ? (
      <div className="offer-modal-overlay" role="dialog" aria-modal="true" aria-label="Match result">
        <div className={`offer-modal ${endgameModal.isWinner ? 'result-win' : 'result-loss'}`}>
          <h3>{endgameModal.title}</h3>
          <p className="meta">{endgameModal.detail}</p>
          {endgameModal.isWinner && (
            <div className="meta small">
              {escrowState?.settled
                ? 'Escrow already settled.'
                : canClaimPayout
                  ? 'Claim payout to transfer winnings to your wallet.'
                  : 'Waiting for escrow state/permissions before payout claim.'}
            </div>
          )}
          <div className="offer-modal-actions">
            <button className="ghost-btn" onClick={() => setEndgameModal({ open: false, isWinner: false, title: '', detail: '' })}>
              Close
            </button>
            {endgameModal.isWinner && (
              <button type="button" onClick={onClaimWinnerPayout} disabled={!canClaimPayout || payoutProcessing}>
                {payoutProcessing ? 'Claiming...' : escrowState?.settled ? 'Paid' : 'Claim Payout'}
              </button>
            )}
          </div>
        </div>
      </div>
    ) : null;

  const aiLevelModal =
    showAiLevelModal ? (
      <div className="offer-modal-overlay" role="dialog" aria-modal="true" aria-label="Select AI level">
        <div className="offer-modal">
          <h3>Play Against AI</h3>
          <p className="meta small">Select a difficulty level.</p>
          <div className="ai-level-grid">
            <button type="button" onClick={() => onStartAiLevel('Beginner')}>Beginner</button>
            <button type="button" onClick={() => onStartAiLevel('Intermediate')}>Intermediate</button>
            <button type="button" onClick={() => onStartAiLevel('Hard')}>Hard</button>
            <button type="button" onClick={() => onStartAiLevel('Master')}>Master</button>
          </div>
          <div className="offer-modal-actions">
            <button className="ghost-btn" onClick={() => setShowAiLevelModal(false)}>Close</button>
          </div>
        </div>
      </div>
    ) : null;

  if (showWelcome && !game) {
    return (
      <>
        <main className="welcome-screen">
          <section className="welcome-hero">
          <p className="tag">LUKSO STREET CHESS</p>
          <h1>Chesso</h1>
          <p className="subtitle">Fast PVP chess Beta with Universal Profiles, real stakes, and loud style.</p>
          <div className="welcome-cta">
            <button className="play-btn" onClick={onPlayNow}>Play Now</button>
            <button className="ghost-btn" onClick={() => setShowWelcome(false)}>Open Lobby</button>
            <div className="theme-toggle-wrap">
              <span className="theme-toggle-label">Theme</span>
              <label className="mode-switch" aria-label="Toggle dark mode">
                <input
                  type="checkbox"
                  checked={theme === 'dark'}
                  onChange={onToggleTheme}
                />
                <span className="mode-slider" />
              </label>
            </div>
          </div>
          <div className="leaderboard">
            <h3>Leaderboard</h3>
            <div className="leaderboard-filters">
              <button
                type="button"
                className={leaderboardFilter === 'stakes' ? '' : 'ghost-btn'}
                onClick={() => setLeaderboardFilter('stakes')}
              >
                Stakes PVP
              </button>
              <button
                type="button"
                className={leaderboardFilter === 'free' ? '' : 'ghost-btn'}
                onClick={() => setLeaderboardFilter('free')}
              >
                Free PVP
              </button>
              <button
                type="button"
                className={leaderboardFilter === 'ai' ? '' : 'ghost-btn'}
                onClick={() => setLeaderboardFilter('ai')}
              >
                AI
              </button>
            </div>
            <div className="leaderboard-table" role="table" aria-label="Top players leaderboard">
              <div className="leaderboard-head" role="row">
                <span>#</span>
                <span>Player</span>
                <span>Wins</span>
                <span>ELO</span>
                <span>Difficulty</span>
              </div>
              {filteredLeaderboardRows.map((row) => (
                <div className="leaderboard-row" role="row" key={row.rank}>
                  <span className="rank-badge">{row.rank}</span>
                  <span className="leader-name">{row.name}</span>
                  <span>{row.wins}</span>
                  <span>{row.elo}</span>
                  <span>{row.difficulty}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="ticker">
            <span>WHITE TO MOVE • CHECK THE CLOCK • RESIGN / DRAW / REMATCH • CHAT LIVE •</span>
          </div>
          {error && <p className="error">{error}</p>}
          </section>
          <section className="welcome-preview">
            <div className="preview-card">
              <div className="preview-title">Board Preview</div>
              <div className="preview-board-slot">
                <ChessGame fen="start" orientation="white" canMove={false} onMove={() => false} theme={theme} />
              </div>
            </div>
          </section>
        </main>
        {isWalletConnecting && (
          <div className="connect-modal-overlay" role="status" aria-live="polite" aria-label="Connecting wallet">
            <div className="connect-modal">
              <div className="connect-spinner" aria-hidden="true" />
              <h3>Connecting...</h3>
              <p>Please approve wallet connection in your Universal Profile extension.</p>
            </div>
          </div>
        )}
        {incomingOfferModal}
        {endgameResultModal}
      </>
    );
  }

  return (
    <main className="layout">
      <section className="panel">
        <h1>Chesso</h1>
        <p>LUKSO PvP chess Beta</p>

        <div className="panel-theme-toggle">
          <span className="theme-toggle-label">Theme</span>
          <label className="mode-switch" aria-label="Toggle dark mode">
            <input
              type="checkbox"
              checked={theme === 'dark'}
              onChange={onToggleTheme}
            />
            <span className="mode-slider" />
          </label>
        </div>

        <button onClick={account ? onDisconnect : onConnectWallet}>
          {account ? 'Disconnect' : isWalletConnecting ? 'Connecting...' : 'Connect UP Wallet'}
        </button>

        <div className="room-actions">
          {!game && <button className="ghost-btn" onClick={onBackToHome}>Back to Home</button>}
        </div>

        <div className="escrow-box">
          <h2>Stakes</h2>
          <input
            placeholder="Escrow contract address (0x...)"
            value={escrowAddress}
            onChange={(e) => setEscrowAddress(e.target.value.trim())}
          />
          <input
            placeholder="Stake amount (18 decimals)"
            value={stakeAmount}
            onChange={(e) => setStakeAmount(e.target.value)}
          />
          <select value={stakeToken} onChange={(e) => setStakeToken(e.target.value)}>
            <option value="native">Native LYX</option>
            <option value="potato">$POTATOE</option>
            <option value="chess">$CHESS</option>
          </select>
          <button
            onClick={onCreateOffer}
            disabled={creatingOffer || !canCreateOfferInputReady}
          >
            Create Offer
          </button>
          {!escrowConfigured && (
            <button type="button" className="ghost-btn" onClick={onDeployEscrow} disabled={deployingEscrow}>
              {deployingEscrow ? 'Deploying Escrow...' : 'Deploy Escrow With Wallet'}
            </button>
          )}
          {!escrowConfigured && (
            <div className="meta small">Enter escrow contract address to enable Create Offer.</div>
          )}
          {assetType === 'lsp7' && !lsp7Configured && (
            <div className="meta small">Token address for {stakeAssetLabel} is missing.</div>
          )}
          {!isStakeAmountValid && (
            <div className="meta small">Stake amount must be greater than 0.</div>
          )}
          <div className="meta small">Escrow: {escrowConfigured ? shortenAddress(escrowAddress) : 'not configured'}</div>
          <div className="stake-link-row">
            <span className="meta small">Share link is ready.</span>
            <button
              type="button"
              disabled={!offerShareLink}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(offerShareLink);
                  setTxStatus('Offer link copied');
                } catch {
                  setError('Could not copy offer link');
                }
              }}
            >
              Copy Link
            </button>
          </div>
          <div className="stake-divider" />
          <div className="quick-play-actions">
            <button type="button" className="ghost-btn" onClick={onCreateFreePvp}>FREE PVP</button>
            <button type="button" className="ghost-btn" onClick={() => setShowAiLevelModal(true)}>Play AI</button>
          </div>
          {txStatus && <div className="meta small">Tx: {txStatus}</div>}
          {escrowState && (
            <div className="meta small">
              <div>Locked: W {escrowState.whiteLocked ? 'yes' : 'no'} / B {escrowState.blackLocked ? 'yes' : 'no'}</div>
              <div>Settled: {escrowState.settled ? 'yes' : 'no'}</div>
              <div>Cancelled: {escrowState.cancelled ? 'yes' : 'no'}</div>
              <div>Lock Deadline: {escrowState.lockDeadline ? new Date(escrowState.lockDeadline * 1000).toLocaleString() : '-'}</div>
            </div>
          )}
        </div>

        <div className="meta compact-meta">
          <div>Status: {connected ? 'Connected' : 'Disconnected'}</div>
          <div>Room: {roomId || 'None'}</div>
          <div>Turn: {game ? (game.turn === 'w' ? 'White' : 'Black') : '-'}</div>
          <div>Result: {game?.result || '-'}</div>
          <div>Clock: {formatMs(game?.clock?.whiteMs)} / {formatMs(game?.clock?.blackMs)}</div>
        </div>

        {error && <p className="error">{error}</p>}
      </section>

      <section className="board-wrap">
        {game ? (
          <div className="game-area">
            <div className="game-board-slot">
              <div className="board-column">
                <ChessGame
                  fen={game.fen}
                  orientation={playerColor}
                  canMove={canMove}
                  onMove={onMove}
                  theme={theme}
                />
                <div className="player-status-box">
                  <h3>Players</h3>
                  <div className="player-status-row">
                    <span className={`status-dot ${whiteOnline ? 'online' : 'offline'}`} />
                    <img className="player-status-avatar" src={whiteAvatar} alt={whiteName} />
                    <span className="player-side">White</span>
                    <span className="player-name">{whiteName}</span>
                  </div>
                  <div className="player-status-row">
                    <span className={`status-dot ${blackOnline ? 'online' : 'offline'}`} />
                    <img className="player-status-avatar" src={blackAvatar} alt={blackName} />
                    <span className="player-side">Black</span>
                    <span className="player-name">{blackName}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="side-panels">
              <aside className="moves-panel">
                <h3>Moves</h3>
                <div className="moves-list">
                  {game.moveHistory?.length ? (
                    game.moveHistory.map((move) => (
                      <div key={`${move.ply}-${move.san}`} className="move-row">
                        <span>#{move.ply}</span>
                        <span>{move.color === 'w' ? 'W' : 'B'}</span>
                        <span>{move.san}</span>
                      </div>
                    ))
                  ) : (
                    <div className="placeholder">No moves yet.</div>
                  )}
                </div>
              </aside>

              <aside className="chat-panel">
                <h3>Chat</h3>
                <div className="chat-joined">
                  {myChatUsername ? (
                    <>
                      <img className="chat-avatar" src={myChatAvatar} alt={myChatUsername} />
                      <span>Logged in as <strong>{myChatUsername}</strong></span>
                    </>
                  ) : (
                    <span>Connecting UP profile...</span>
                  )}
                </div>
                <div className="chat-messages">
                  {chatMessages.length ? (
                    chatMessages.map((m) => (
                      <div className="chat-msg" key={m.id}>
                        <div className="chat-msg-head">
                          <span>{m.username}</span>
                          <span>{formatChatTime(m.at)}</span>
                        </div>
                        <div className="chat-msg-body">
                          <img className="chat-avatar" src={m.avatar || `https://api.dicebear.com/9.x/identicon/svg?seed=${m.address}`} alt={m.username} />
                          <div>{m.text}</div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="placeholder">No chat yet. Start the conversation.</div>
                  )}
                </div>
                <div className="chat-compose">
                  <input
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                    placeholder="Type message"
                    maxLength={280}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onSendChat();
                    }}
                  />
                  <button onClick={onSendChat}>Send</button>
                </div>
              </aside>

              <aside className="activity-panel">
                <h3>Activity</h3>
                <div className="activity-list">
                  {activityItems.length ? (
                    activityItems.map((item) => (
                      <div className="activity-item" key={item.id}>
                        <div className="activity-head">
                          <strong>{item.title}</strong>
                          <span>{formatChatTime(item.at)}</span>
                        </div>
                        <div>{item.detail}</div>
                        {item.link && (
                          <div className="activity-link-row">
                            <a href={item.link} target="_blank" rel="noreferrer">{item.link}</a>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(item.link);
                                  setTxStatus('Offer link copied');
                                } catch {
                                  setError('Could not copy link');
                                }
                              }}
                            >
                              Copy
                            </button>
                          </div>
                        )}
                        {item.txHash && (
                          <div className="activity-link-row">
                            <code>{shortenAddress(item.txHash)}</code>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(item.txHash);
                                  setTxStatus('Tx hash copied');
                                } catch {
                                  setError('Could not copy tx hash');
                                }
                              }}
                            >
                              Copy Tx
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="placeholder">No offers yet. Send your first offer.</div>
                  )}
                </div>
              </aside>
            </div>
          </div>
        ) : (
          <div className="lobby-preview">
            <div className="preview-card">
              <div className="preview-title">Game Preview</div>
              <div className="preview-layout">
                <div className="preview-board-slot">
                  <ChessGame fen="start" orientation="white" canMove={false} onMove={() => false} theme={theme} />
                </div>
                <div className="preview-side-panels">
                  <aside className="chat-panel preview-chat">
                    <h3>Chat</h3>
                  <div className="placeholder">Chat is available once your room is open.</div>
                  <div className="chat-joined">
                    <img
                      className="chat-avatar"
                      src={
                        profile.avatar ||
                        (account
                          ? `https://api.dicebear.com/9.x/identicon/svg?seed=${account}`
                          : 'https://api.dicebear.com/9.x/identicon/svg?seed=chesso-preview')
                      }
                      alt={profile.username || 'Preview avatar'}
                    />
                    <span>
                      {profile.username
                        ? `Logged in as ${profile.username}`
                        : account
                          ? `Logged in as Player-${account.slice(2, 6)}`
                          : 'UP profile auto-connects to chat'}
                    </span>
                  </div>
                    <div className="chat-messages">
                      <div className="chat-msg">
                        <div className="chat-msg-head">
                          <span>System</span>
                          <span>--:--</span>
                        </div>
                        <div className="chat-msg-body">
                          <img
                            className="chat-avatar"
                            src="https://api.dicebear.com/9.x/identicon/svg?seed=system"
                            alt="System"
                          />
                          <div>Chat appears here as soon as messages are sent.</div>
                        </div>
                      </div>
                    </div>
                  </aside>
                  <aside className="activity-panel">
                    <h3>Activity</h3>
                    <div className="placeholder">Offers and links will appear here.</div>
                  </aside>
                </div>
              </div>
              <p className="placeholder">Create or join a room to start.</p>
            </div>
          </div>
        )}
      </section>
      {isWalletConnecting && (
        <div className="connect-modal-overlay" role="status" aria-live="polite" aria-label="Connecting wallet">
          <div className="connect-modal">
            <div className="connect-spinner" aria-hidden="true" />
            <h3>Connecting...</h3>
            <p>Please approve wallet connection in your Universal Profile extension.</p>
          </div>
        </div>
      )}
      {incomingOfferModal}
      {endgameResultModal}
      {aiLevelModal}
      {offerProgress.open && (
        <div className="connect-modal-overlay" role="status" aria-live="polite" aria-label="Creating offer">
          <div className="connect-modal">
            <div className="connect-spinner" aria-hidden="true" />
            <h3>{offerProgress.title}</h3>
            <p>{offerProgress.detail}</p>
            {!creatingOffer && (
              <button type="button" className="ghost-btn" onClick={() => setOfferProgress({ open: false, title: '', detail: '' })}>
                Close
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
