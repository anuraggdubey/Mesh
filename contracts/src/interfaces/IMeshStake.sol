// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMeshStake {
    function stakeOf(address provider) external view returns (uint256);
    function isEligible(address provider, uint256 minStake) external view returns (bool);
    /// @notice Slash up to `amount` of the provider's stake. The slashed funds are sent to the caller (receipt).
    /// @return slashed the amount actually slashed (capped at the provider's stake).
    function slash(address provider, bytes32 jobId, uint256 amount, bytes32 reason) external returns (uint256 slashed);
    /// @notice Prevent unstaking until `until` (set by the receipt contract while a claim is pending).
    function extendLock(address provider, uint64 until) external;
}
