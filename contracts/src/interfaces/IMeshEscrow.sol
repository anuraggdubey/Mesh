// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMeshEscrow {
    enum EscrowStatus {
        None,
        Locked,
        Released,
        Refunded
    }

    function statusOf(bytes32 jobId) external view returns (EscrowStatus);
    function release(bytes32 jobId, address[] calldata providers) external;
    function refund(bytes32 jobId) external;
}
