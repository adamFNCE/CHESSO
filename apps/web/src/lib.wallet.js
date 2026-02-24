import { BrowserProvider, Contract, ethers } from 'ethers';

const LSP3_PROFILE_KEY = '0x5ef83ad9559033e6e941db7d7c495acdce616347d28e90c7ce47cbfcfcad3bc5';
const IPFS_GATEWAY = 'https://api.universalprofile.cloud/ipfs/';

function toGatewayUrl(url) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('ipfs://')) return `${IPFS_GATEWAY}${url.slice('ipfs://'.length)}`;
  return url;
}

function getFallbackProfile(account) {
  return {
    username: `Player-${account.slice(2, 6)}`,
    avatar: `https://api.dicebear.com/9.x/identicon/svg?seed=${account}`
  };
}

function extractFirstUrlFromVerifiableURI(encodedValue) {
  if (!encodedValue || encodedValue === '0x') return '';
  const bytes = ethers.getBytes(encodedValue);
  let plain = '';
  for (const byte of bytes) {
    plain += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ' ';
  }
  const match = plain.match(/(ipfs:\/\/[^\s]+|https?:\/\/[^\s]+)/i);
  return match?.[1] || '';
}

async function fetchUniversalProfile(account, provider) {
  try {
    const ethersProvider = new BrowserProvider(provider);
    const up = new Contract(account, ['function getData(bytes32) view returns (bytes)'], ethersProvider);
    const encoded = await up.getData(LSP3_PROFILE_KEY);
    const metadataUrl = extractFirstUrlFromVerifiableURI(encoded);
    if (!metadataUrl) return getFallbackProfile(account);

    const response = await fetch(toGatewayUrl(metadataUrl));
    if (!response.ok) return getFallbackProfile(account);
    const payload = await response.json();
    const lsp3 = payload?.LSP3Profile || payload || {};

    const username = String(lsp3?.name || '').trim() || getFallbackProfile(account).username;
    const image = Array.isArray(lsp3?.profileImage) ? lsp3.profileImage[0] : null;
    const avatar = toGatewayUrl(image?.url || '') || getFallbackProfile(account).avatar;
    return { username, avatar };
  } catch {
    return getFallbackProfile(account);
  }
}

export async function connectUniversalProfile() {
  const provider = window?.lukso || window?.ethereum;

  if (!provider) {
    throw new Error('No compatible wallet provider found. Install Universal Profiles extension.');
  }

  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const account = accounts?.[0] || null;
  if (!account) return { provider, account: null, profile: null };
  const profile = await fetchUniversalProfile(account, provider);
  return { provider, account, profile };
}
