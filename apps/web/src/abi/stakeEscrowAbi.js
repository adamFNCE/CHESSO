export const stakeEscrowAbi = [
  'constructor(address _arbiter,uint64 _lockWindowSeconds,address _feeRecipient,uint16 _protocolFeeBps)',
  'function createMatch(bytes32 matchId,address white,address black,address asset,uint256 amount,uint8 assetType)',
  'function lockNativeStake(bytes32 matchId) payable',
  'function lockLSP7Stake(bytes32 matchId)',
  'function refundAfterLockExpiry(bytes32 matchId)',
  'function settle(bytes32 matchId,address winner)',
  'function arbiter() view returns (address)',
  'function feeRecipient() view returns (address)',
  'function protocolFeeBps() view returns (uint16)',
  'function lockWindowSeconds() view returns (uint64)',
  'function matches(bytes32) view returns (address white,address black,address winner,uint256 stakeAmount,address asset,uint8 assetType,uint64 lockDeadline,bool whiteLocked,bool blackLocked,bool settled,bool cancelled)'
];
