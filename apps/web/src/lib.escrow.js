import { BrowserProvider, ethers } from 'ethers';
import { stakeEscrowAbi } from './abi/stakeEscrowAbi.js';
import { stakeEscrowBytecode } from './abi/stakeEscrowBytecode.js';

function getMatchId(roomId) {
  return ethers.keccak256(ethers.toUtf8Bytes(roomId));
}

async function getContract(walletProvider, escrowAddress) {
  if (!escrowAddress) throw new Error('Missing VITE_ESCROW_ADDRESS');
  const provider = new BrowserProvider(walletProvider);
  const signer = await provider.getSigner();
  return new ethers.Contract(escrowAddress, stakeEscrowAbi, signer);
}

async function getSigner(walletProvider) {
  const provider = new BrowserProvider(walletProvider);
  return provider.getSigner();
}

export async function createEscrowMatch({
  walletProvider,
  escrowAddress,
  roomId,
  white,
  black,
  stakeAmount,
  assetType,
  lsp7Asset
}) {
  const contract = await getContract(walletProvider, escrowAddress);
  const matchId = getMatchId(roomId);
  const stakeAmountWei = ethers.parseUnits(stakeAmount || '0', 18);
  const asset = assetType === 'native' ? ethers.ZeroAddress : lsp7Asset;
  const assetTypeValue = assetType === 'native' ? 0 : 1;

  const tx = await contract.createMatch(matchId, white, black, asset, stakeAmountWei, assetTypeValue);
  await tx.wait();
  return { txHash: tx.hash, matchId };
}

export async function lockEscrowStake({
  walletProvider,
  escrowAddress,
  roomId,
  stakeAmount,
  assetType,
  lsp7Asset,
  playerAddress,
  skipLsp7Transfer = false
}) {
  const contract = await getContract(walletProvider, escrowAddress);
  const matchId = getMatchId(roomId);

  if (assetType === 'native') {
    const tx = await contract.lockNativeStake(matchId, {
      value: ethers.parseUnits(stakeAmount || '0', 18)
    });
    await tx.wait();
    return { txHash: tx.hash, matchId };
  }

  if (!lsp7Asset || !playerAddress) {
    throw new Error('Missing LSP7 asset address or player address');
  }

  const signer = await getSigner(walletProvider);
  const token = new ethers.Contract(
    lsp7Asset,
    ['function transfer(address from,address to,uint256 amount,bool force,bytes data)'],
    signer
  );

  const amount = ethers.parseUnits(stakeAmount || '0', 18);
  let transferTx = null;
  if (!skipLsp7Transfer) {
    transferTx = await token.transfer(playerAddress, escrowAddress, amount, true, '0x');
    await transferTx.wait();
  }

  const lockTx = await contract.lockLSP7Stake(matchId);
  await lockTx.wait();
  return { txHash: lockTx.hash, transferTxHash: transferTx?.hash || null, matchId };
}

export async function preFundLsp7Stake({
  walletProvider,
  escrowAddress,
  stakeAmount,
  lsp7Asset,
  playerAddress
}) {
  if (!escrowAddress) throw new Error('Missing escrow address');
  if (!lsp7Asset || !playerAddress) throw new Error('Missing LSP7 asset address or player address');
  const signer = await getSigner(walletProvider);
  const token = new ethers.Contract(
    lsp7Asset,
    ['function transfer(address from,address to,uint256 amount,bool force,bytes data)'],
    signer
  );
  const amount = ethers.parseUnits(stakeAmount || '0', 18);
  const transferTx = await token.transfer(playerAddress, escrowAddress, amount, true, '0x');
  await transferTx.wait();
  return { txHash: transferTx.hash };
}

export async function settleEscrowMatch({ walletProvider, escrowAddress, roomId, winner }) {
  const contract = await getContract(walletProvider, escrowAddress);
  const matchId = getMatchId(roomId);
  const tx = await contract.settle(matchId, winner);
  await tx.wait();
  return { txHash: tx.hash, matchId };
}

export async function refundExpiredStake({ walletProvider, escrowAddress, roomId }) {
  const contract = await getContract(walletProvider, escrowAddress);
  const matchId = getMatchId(roomId);
  const tx = await contract.refundAfterLockExpiry(matchId);
  await tx.wait();
  return { txHash: tx.hash, matchId };
}

export async function readEscrowMatch({ walletProvider, escrowAddress, roomId }) {
  const contract = await getContract(walletProvider, escrowAddress);
  const matchId = getMatchId(roomId);
  const data = await contract.matches(matchId);
  return {
    matchId,
    white: data.white,
    black: data.black,
    winner: data.winner,
    stakeAmount: data.stakeAmount.toString(),
    asset: data.asset,
    assetType: Number(data.assetType),
    lockDeadline: Number(data.lockDeadline),
    whiteLocked: data.whiteLocked,
    blackLocked: data.blackLocked,
    settled: data.settled,
    cancelled: data.cancelled
  };
}

export async function deployStakeEscrow({
  walletProvider,
  arbiter,
  feeRecipient,
  lockWindowSeconds = 900,
  protocolFeeBps = 500
}) {
  if (!walletProvider) throw new Error('Wallet provider unavailable');
  if (!arbiter) throw new Error('Missing arbiter address');
  if (!feeRecipient) throw new Error('Missing fee recipient address');

  const signer = await getSigner(walletProvider);
  const factory = new ethers.ContractFactory(stakeEscrowAbi, stakeEscrowBytecode, signer);
  const contract = await factory.deploy(arbiter, Number(lockWindowSeconds), feeRecipient, Number(protocolFeeBps));
  await contract.waitForDeployment();
  const escrowAddress = await contract.getAddress();
  return { escrowAddress, txHash: contract.deploymentTransaction()?.hash || null };
}
