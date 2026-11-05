// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMeshStake} from "./interfaces/IMeshStake.sol";

/// @notice Provider stake. Native currency (HBAR on Hedera). Providers must be World-ID registered (one profile per
/// human) before they count as eligible. Only the receipt contract can slash. See docs/job-spec.md section 8.2.
contract MeshStake is IMeshStake {
    address public immutable owner;
    address public immutable api;
    uint256 public immutable unlockDelay;

    address public receipt; // set once

    mapping(address => uint256) public stakeOf;
    mapping(address => uint64) public lockedUntil; // cannot unstake before this (pending claim window)
    mapping(address => uint64) public unstakeRequestedAt;

    mapping(bytes32 => address) public nullifierOwner; // World ID nullifier => provider
    mapping(address => bytes32) public providerNullifier;
    mapping(bytes32 => bool) public slashedForJob;

    uint256 private _locked = 1;

    event Registered(address indexed provider, bytes32 indexed nullifier);
    event Staked(address indexed provider, uint256 amount);
    event UnstakeRequested(address indexed provider, uint64 availableAt);
    event Unstaked(address indexed provider, uint256 amount);
    event Slashed(address indexed provider, bytes32 indexed jobId, uint256 amount, bytes32 reason);

    error NotOwner();
    error NotApi();
    error NotReceipt();
    error ReceiptAlreadySet();
    error AlreadyRegistered();
    error NullifierUsed();
    error NotRegistered();
    error ZeroAmount();
    error InsufficientStake();
    error StillLocked();
    error NotRequested();
    error AlreadySlashed();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address api_, uint256 unlockDelay_) {
        owner = msg.sender;
        api = api_;
        unlockDelay = unlockDelay_;
    }

    function setReceipt(address receipt_) external {
        if (msg.sender != owner) revert NotOwner();
        if (receipt != address(0)) revert ReceiptAlreadySet();
        receipt = receipt_;
    }

    /// @notice Called by the API after the World ID proof is verified server-side. One provider profile per human.
    function registerProvider(address provider, bytes32 worldNullifier) external {
        if (msg.sender != api) revert NotApi();
        if (providerNullifier[provider] != bytes32(0)) revert AlreadyRegistered();
        if (nullifierOwner[worldNullifier] != address(0)) revert NullifierUsed();
        nullifierOwner[worldNullifier] = provider;
        providerNullifier[provider] = worldNullifier;
        emit Registered(provider, worldNullifier);
    }

    function isRegistered(address provider) public view returns (bool) {
        return providerNullifier[provider] != bytes32(0);
    }

    function isEligible(address provider, uint256 minStake) external view returns (bool) {
        return isRegistered(provider) && stakeOf[provider] >= minStake;
    }

    function stake() external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (!isRegistered(msg.sender)) revert NotRegistered();
        stakeOf[msg.sender] += msg.value;
        unstakeRequestedAt[msg.sender] = 0; // staking more cancels a pending unstake
        emit Staked(msg.sender, msg.value);
    }

    function requestUnstake() external {
        uint64 availableAt = uint64(block.timestamp + unlockDelay);
        unstakeRequestedAt[msg.sender] = uint64(block.timestamp);
        emit UnstakeRequested(msg.sender, availableAt);
    }

    function unstake(uint256 amount) external nonReentrant {
        uint64 requested = unstakeRequestedAt[msg.sender];
        if (requested == 0) revert NotRequested();
        if (block.timestamp < requested + unlockDelay) revert StillLocked();
        if (block.timestamp < lockedUntil[msg.sender]) revert StillLocked();
        if (amount == 0) revert ZeroAmount();
        if (stakeOf[msg.sender] < amount) revert InsufficientStake();

        stakeOf[msg.sender] -= amount;
        unstakeRequestedAt[msg.sender] = 0;
        emit Unstaked(msg.sender, amount);

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function extendLock(address provider, uint64 until) external {
        if (msg.sender != receipt) revert NotReceipt();
        if (until > lockedUntil[provider]) lockedUntil[provider] = until;
    }

    function slash(address provider, bytes32 jobId, uint256 amount, bytes32 reason)
        external
        nonReentrant
        returns (uint256 slashed)
    {
        if (msg.sender != receipt) revert NotReceipt();
        if (slashedForJob[jobId]) revert AlreadySlashed();
        slashedForJob[jobId] = true;

        uint256 balance = stakeOf[provider];
        slashed = amount > balance ? balance : amount;
        stakeOf[provider] = balance - slashed;
        emit Slashed(provider, jobId, slashed, reason);

        if (slashed > 0) {
            (bool ok,) = payable(msg.sender).call{value: slashed}("");
            if (!ok) revert TransferFailed();
        }
    }
}
