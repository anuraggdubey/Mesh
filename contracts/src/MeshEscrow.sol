// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IMeshEscrow} from "./interfaces/IMeshEscrow.sol";

/// @notice Holds requester payment for a job. The x402 payment transfers `token` straight to this contract
/// (payTo = escrow, nonce = jobId); the API then calls `lock` to record it. Settlement is driven by the receipt
/// contract: `release` after a final receipt, `refund` after fraud / failure / expiry. See docs/job-spec.md 8.3.
contract MeshEscrow is IMeshEscrow {
    IERC20 public immutable token;
    address public immutable owner;
    address public immutable api;
    uint256 public immutable refundAfter; // anyone may refund a still-locked job after this many seconds

    address public receipt; // set once

    struct Entry {
        EscrowStatus status;
        address requester;
        uint256 amount;
        uint64 lockedAt;
    }

    mapping(bytes32 => Entry) public entries;
    uint256 public held; // sum of amounts in Locked state

    uint256 private _locked = 1;

    event Locked(bytes32 indexed jobId, address indexed requester, uint256 amount);
    event Released(bytes32 indexed jobId, uint256 amount);
    event Refunded(bytes32 indexed jobId, uint256 amount);

    error NotOwner();
    error NotApi();
    error NotReceipt();
    error ReceiptAlreadySet();
    error AlreadyLocked();
    error NotLocked();
    error PaymentNotReceived();
    error ZeroAmount();
    error NoProviders();
    error NotAuthorizedToRefund();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(IERC20 token_, address api_, uint256 refundAfter_) {
        token = token_;
        owner = msg.sender;
        api = api_;
        refundAfter = refundAfter_;
    }

    function setReceipt(address receipt_) external {
        if (msg.sender != owner) revert NotOwner();
        if (receipt != address(0)) revert ReceiptAlreadySet();
        receipt = receipt_;
    }

    function statusOf(bytes32 jobId) external view returns (EscrowStatus) {
        return entries[jobId].status;
    }

    /// @notice Record a payment that has already arrived at this contract. The contract checks its token balance
    /// covers everything it holds, so the API cannot lock funds that were never paid.
    function lock(bytes32 jobId, address requester, uint256 amount) external {
        if (msg.sender != api) revert NotApi();
        if (amount == 0) revert ZeroAmount();
        if (entries[jobId].status != EscrowStatus.None) revert AlreadyLocked();
        if (token.balanceOf(address(this)) < held + amount) revert PaymentNotReceived();

        entries[jobId] = Entry(EscrowStatus.Locked, requester, amount, uint64(block.timestamp));
        held += amount;
        emit Locked(jobId, requester, amount);
    }

    /// @notice Pay the providers (equal split; any remainder goes to the first provider).
    function release(bytes32 jobId, address[] calldata providers) external nonReentrant {
        if (msg.sender != receipt) revert NotReceipt();
        if (providers.length == 0) revert NoProviders();
        Entry storage e = entries[jobId];
        if (e.status != EscrowStatus.Locked) revert NotLocked();

        uint256 amount = e.amount;
        e.status = EscrowStatus.Released;
        held -= amount;
        emit Released(jobId, amount);

        uint256 share = amount / providers.length;
        uint256 remainder = amount - share * providers.length;
        for (uint256 i = 0; i < providers.length; i++) {
            _send(providers[i], i == 0 ? share + remainder : share);
        }
    }

    /// @notice Return the payment to the requester. Callable by the receipt contract, the API, or anyone once the
    /// job has been locked for `refundAfter` seconds without being released.
    function refund(bytes32 jobId) external nonReentrant {
        Entry storage e = entries[jobId];
        if (e.status != EscrowStatus.Locked) revert NotLocked();
        bool privileged = msg.sender == receipt || msg.sender == api;
        if (!privileged && block.timestamp < uint256(e.lockedAt) + refundAfter) revert NotAuthorizedToRefund();

        uint256 amount = e.amount;
        e.status = EscrowStatus.Refunded;
        held -= amount;
        emit Refunded(jobId, amount);

        _send(e.requester, amount);
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
