// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMeshStake} from "./interfaces/IMeshStake.sol";
import {IMeshEscrow} from "./interfaces/IMeshEscrow.sol";
import {MerkleSha256} from "./libraries/MerkleSha256.sol";

/// @notice Append-only compute receipts. Optimistic verification: a claim is Pending for a challenge window, can be
/// proven fraudulent by the verifier, and otherwise becomes Final. AI jobs are Attested by a 0G TEE signature.
/// See docs/job-spec.md section 8.1. Known v1 limit: the API attributes tiles to providers (the owner address is
/// inside each Merkle leaf) and the verifier key supplies the "expected" tile hash for a fraud proof.
contract MeshReceipt {
    using MerkleSha256 for bytes32;

    enum Status {
        None,
        Pending,
        Final,
        Rejected,
        Attested
    }

    struct Receipt {
        Status status;
        address requester;
        bytes32 imageDigest;
        bytes32 inputHash;
        bytes32 merkleRoot; // for infer jobs: the output digest
        uint64 postedAt;
        uint64 windowEnd;
        bytes32 attestationDigest; // infer only
        string zeroGRequestId; // infer only
    }

    address public immutable owner;
    address public immutable api;
    address public immutable verifier;
    IMeshStake public immutable stake;
    IMeshEscrow public immutable escrow;

    address public ogSigner; // 0G TEE signer address (TBD-VERIFY with 0G docs)
    uint64 public windowSeconds;
    uint256 public minStake;
    uint256 public slashAmount;

    uint256 public constant MAX_TILES = 4096;
    uint256 public constant MAX_PROVIDERS = 16;
    bytes32 public constant REASON_FRAUD = "FRAUD";

    mapping(bytes32 => Receipt) private _receipts;
    mapping(bytes32 => address[]) private _providers;
    mapping(bytes32 => uint16) public tileCountOf;

    uint256 private _locked = 1;

    event ClaimPosted(bytes32 indexed jobId, address indexed requester, bytes32 merkleRoot, uint64 windowEnd);
    event ReceiptFinal(bytes32 indexed jobId);
    event FraudProven(bytes32 indexed jobId, uint16 tileIndex, address indexed owner);
    event AttestedPosted(bytes32 indexed jobId, bytes32 outputDigest, string zeroGRequestId);
    event SlashDistributed(bytes32 indexed jobId, uint256 toRequester, uint256 toVerifier, uint256 retained);

    error NotOwner();
    error NotApi();
    error NotVerifier();
    error NotPending();
    error AlreadyPosted();
    error NotPaid();
    error BadTileCount();
    error BadProviders();
    error NotEligible(address provider);
    error WindowOpen();
    error WindowClosed();
    error BadTileIndex();
    error NotTileOwner();
    error NotFraud();
    error BadProof();
    error BadSignature();
    error WrongSigner();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier onlyApi() {
        if (msg.sender != api) revert NotApi();
        _;
    }

    constructor(
        address api_,
        address verifier_,
        IMeshStake stake_,
        IMeshEscrow escrow_,
        address ogSigner_,
        uint64 windowSeconds_,
        uint256 minStake_,
        uint256 slashAmount_
    ) {
        owner = msg.sender;
        api = api_;
        verifier = verifier_;
        stake = stake_;
        escrow = escrow_;
        ogSigner = ogSigner_;
        windowSeconds = windowSeconds_;
        minStake = minStake_;
        slashAmount = slashAmount_;
    }

    receive() external payable {}

    // ───────────────────────── admin ─────────────────────────

    function setConfig(address ogSigner_, uint64 windowSeconds_, uint256 minStake_, uint256 slashAmount_) external {
        if (msg.sender != owner) revert NotOwner();
        ogSigner = ogSigner_;
        windowSeconds = windowSeconds_;
        minStake = minStake_;
        slashAmount = slashAmount_;
    }

    /// @notice Withdraw the retained share of slashed stake.
    function withdrawRetained(address payable to, uint256 amount) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ───────────────────────── deterministic jobs ─────────────────────────

    /// @notice Post a provider claim. Opens the challenge window. Requires the payment to be locked in escrow and
    /// every provider to be registered and staked.
    function postClaim(
        bytes32 jobId,
        address requester,
        bytes32 imageDigest,
        bytes32 inputHash,
        bytes32 merkleRoot,
        address[] calldata providers,
        uint16 tileCount
    ) external onlyApi {
        if (_receipts[jobId].status != Status.None) revert AlreadyPosted();
        if (escrow.statusOf(jobId) != IMeshEscrow.EscrowStatus.Locked) revert NotPaid();
        if (tileCount == 0 || tileCount > MAX_TILES || !MerkleSha256.isPowerOfTwo(tileCount)) revert BadTileCount();
        if (providers.length == 0 || providers.length > MAX_PROVIDERS) revert BadProviders();

        uint64 windowEnd = uint64(block.timestamp) + windowSeconds;
        for (uint256 i = 0; i < providers.length; i++) {
            address p = providers[i];
            if (p == address(0)) revert BadProviders();
            for (uint256 j = 0; j < i; j++) {
                if (providers[j] == p) revert BadProviders();
            }
            if (!stake.isEligible(p, minStake)) revert NotEligible(p);
            stake.extendLock(p, windowEnd);
        }

        Receipt storage r = _receipts[jobId];
        r.status = Status.Pending;
        r.requester = requester;
        r.imageDigest = imageDigest;
        r.inputHash = inputHash;
        r.merkleRoot = merkleRoot;
        r.postedAt = uint64(block.timestamp);
        r.windowEnd = windowEnd;
        _providers[jobId] = providers;
        tileCountOf[jobId] = tileCount;

        emit ClaimPosted(jobId, requester, merkleRoot, windowEnd);
    }

    /// @notice Anyone may finalize after the challenge window if no fraud was proven. Releases escrow.
    function finalize(bytes32 jobId) external nonReentrant {
        Receipt storage r = _receipts[jobId];
        if (r.status != Status.Pending) revert NotPending();
        if (block.timestamp <= r.windowEnd) revert WindowOpen();

        r.status = Status.Final;
        emit ReceiptFinal(jobId);
        escrow.release(jobId, _providers[jobId]);
    }

    /// @notice Verifier proves one tile in the committed root is wrong. Slashes the tile owner, refunds the requester.
    function postFraud(
        bytes32 jobId,
        uint16 tileIndex,
        address tileOwner,
        bytes32 expectedTileHash,
        bytes32 claimedTileHash,
        bytes32[] calldata proof
    ) external nonReentrant {
        if (msg.sender != verifier) revert NotVerifier();
        Receipt storage r = _receipts[jobId];
        if (r.status != Status.Pending) revert NotPending();
        if (block.timestamp > r.windowEnd) revert WindowClosed();
        if (expectedTileHash == claimedTileHash) revert NotFraud();

        uint16 tileCount = tileCountOf[jobId];
        if (tileIndex >= tileCount) revert BadTileIndex();
        address[] storage provs = _providers[jobId];
        if (provs[tileIndex % provs.length] != tileOwner) revert NotTileOwner();
        if (proof.length != MerkleSha256.depth(tileCount)) revert BadProof();

        bytes32 leafHash = MerkleSha256.leaf(tileIndex, claimedTileHash, tileOwner);
        bytes32[] memory proofMem = proof;
        if (MerkleSha256.computeRoot(leafHash, tileIndex, proofMem) != r.merkleRoot) revert BadProof();

        r.status = Status.Rejected;
        emit FraudProven(jobId, tileIndex, tileOwner);

        uint256 slashed = stake.slash(tileOwner, jobId, slashAmount, REASON_FRAUD);
        escrow.refund(jobId);
        _distributeSlash(jobId, r.requester, slashed);
    }

    function _distributeSlash(bytes32 jobId, address requester, uint256 slashed) internal {
        uint256 toRequester = slashed / 2;
        uint256 toVerifier = slashed / 4;
        uint256 retained = slashed - toRequester - toVerifier;
        // best effort: a reverting recipient must not block the refund/slash outcome
        if (toRequester > 0) {
            (bool sentRequester,) = payable(requester).call{value: toRequester}("");
            sentRequester; // ignored on purpose
        }
        if (toVerifier > 0) {
            (bool sentVerifier,) = payable(verifier).call{value: toVerifier}("");
            sentVerifier; // ignored on purpose
        }
        emit SlashDistributed(jobId, toRequester, toVerifier, retained);
    }

    // ───────────────────────── attested (AI) jobs ─────────────────────────

    /// @notice Post an AI result that carries a 0G TEE signature over `outputDigest`. The contract recovers the
    /// signer (EIP-191 personal_sign over the 32-byte digest) and requires it to equal `ogSigner`.
    /// TBD-VERIFY: the exact message 0G signs; adjust `_recoverEip191` accordingly once confirmed.
    function postAttested(
        bytes32 jobId,
        address requester,
        address provider,
        bytes32 outputDigest,
        string calldata zeroGRequestId,
        bytes calldata teeSignature
    ) external onlyApi nonReentrant {
        if (_receipts[jobId].status != Status.None) revert AlreadyPosted();
        if (escrow.statusOf(jobId) != IMeshEscrow.EscrowStatus.Locked) revert NotPaid();
        if (!stake.isEligible(provider, minStake)) revert NotEligible(provider);
        if (_recoverEip191(outputDigest, teeSignature) != ogSigner || ogSigner == address(0)) revert WrongSigner();

        Receipt storage r = _receipts[jobId];
        r.status = Status.Attested;
        r.requester = requester;
        r.merkleRoot = outputDigest;
        r.postedAt = uint64(block.timestamp);
        r.attestationDigest = outputDigest;
        r.zeroGRequestId = zeroGRequestId;
        address[] memory single = new address[](1);
        single[0] = provider;
        _providers[jobId] = single;
        tileCountOf[jobId] = 1;

        emit AttestedPosted(jobId, outputDigest, zeroGRequestId);
        escrow.release(jobId, single);
    }

    function _recoverEip191(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        // reject malleable signatures
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        bytes32 hash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address signer = ecrecover(hash, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    // ───────────────────────── views ─────────────────────────

    function getReceipt(bytes32 jobId) external view returns (Receipt memory) {
        return _receipts[jobId];
    }

    function providersOf(bytes32 jobId) external view returns (address[] memory) {
        return _providers[jobId];
    }

    /// @notice Pure helpers so off-chain code (and golden-vector tests) can check the exact tree encoding.
    function computeLeaf(uint16 index, bytes32 tileHash, address tileOwner) external pure returns (bytes32) {
        return MerkleSha256.leaf(index, tileHash, tileOwner);
    }

    function verifyTile(
        bytes32 merkleRoot,
        uint16 index,
        bytes32 tileHash,
        address tileOwner,
        bytes32[] calldata proof
    ) external pure returns (bool) {
        bytes32[] memory proofMem = proof;
        return MerkleSha256.computeRoot(MerkleSha256.leaf(index, tileHash, tileOwner), index, proofMem) == merkleRoot;
    }
}
