// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockStable} from "../src/MockStable.sol";
import {MeshStake} from "../src/MeshStake.sol";
import {MeshEscrow} from "../src/MeshEscrow.sol";
import {MeshReceipt} from "../src/MeshReceipt.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IMeshStake} from "../src/interfaces/IMeshStake.sol";
import {IMeshEscrow} from "../src/interfaces/IMeshEscrow.sol";
import {MerkleSha256} from "../src/libraries/MerkleSha256.sol";

/// @dev Shared deployment + a Solidity implementation of the spec's Merkle tree used to build proofs in tests.
abstract contract Base is Test {
    address internal api = makeAddr("api");
    address internal verifier = makeAddr("verifier");
    address internal requester = makeAddr("requester");
    address internal p1 = makeAddr("provider1");
    address internal p2 = makeAddr("provider2");
    address internal stranger = makeAddr("stranger");

    uint256 internal ogKey = 0xA11CE;
    address internal ogSigner;

    uint256 internal constant UNLOCK_DELAY = 100;
    uint256 internal constant REFUND_AFTER = 3600;
    uint64 internal constant WINDOW = 45;
    uint256 internal constant MIN_STAKE = 10 ether;
    uint256 internal constant SLASH = 4 ether;
    uint256 internal constant PRICE = 1_000_000;

    MockStable internal token;
    MeshStake internal stake;
    MeshEscrow internal escrow;
    MeshReceipt internal receipt;

    function setUp() public virtual {
        ogSigner = vm.addr(ogKey);
        token = new MockStable();
        stake = new MeshStake(api, UNLOCK_DELAY);
        escrow = new MeshEscrow(IERC20(address(token)), api, REFUND_AFTER);
        receipt = new MeshReceipt(
            api, verifier, IMeshStake(address(stake)), IMeshEscrow(address(escrow)), ogSigner, WINDOW, MIN_STAKE, SLASH
        );
        stake.setReceipt(address(receipt));
        escrow.setReceipt(address(receipt));
    }

    // ───────── helpers ─────────

    function _registerAndStake(address p, bytes32 nullifier, uint256 amount) internal {
        vm.prank(api);
        stake.registerProvider(p, nullifier);
        vm.deal(p, amount);
        vm.prank(p);
        stake.stake{value: amount}();
    }

    function _payAndLock(bytes32 jobId, uint256 amount) internal {
        token.mint(address(escrow), amount);
        vm.prank(api);
        escrow.lock(jobId, requester, amount);
    }

    function _tileHash(uint256 i) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("tile", i));
    }

    /// @dev Build the spec tree for `n` (power of two) tiles. Owner of tile i is owners[i % owners.length].
    ///      levels[0] = leaves, levels[last] = [root].
    function _buildTree(bytes32[] memory tileHashes, address[] memory owners)
        internal
        pure
        returns (bytes32[][] memory levels)
    {
        uint256 n = tileHashes.length;
        uint256 depth = MerkleSha256.depth(n);
        levels = new bytes32[][](depth + 1);
        levels[0] = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            levels[0][i] = MerkleSha256.leaf(uint16(i), tileHashes[i], owners[i % owners.length]);
        }
        for (uint256 l = 1; l <= depth; l++) {
            uint256 size = n >> l;
            levels[l] = new bytes32[](size);
            for (uint256 j = 0; j < size; j++) {
                levels[l][j] = MerkleSha256.node(levels[l - 1][2 * j], levels[l - 1][2 * j + 1]);
            }
        }
    }

    function _proof(bytes32[][] memory levels, uint256 index) internal pure returns (bytes32[] memory proof) {
        uint256 depth = levels.length - 1;
        proof = new bytes32[](depth);
        uint256 idx = index;
        for (uint256 l = 0; l < depth; l++) {
            proof[l] = levels[l][idx ^ 1];
            idx >>= 1;
        }
    }

    function _root(bytes32[][] memory levels) internal pure returns (bytes32) {
        return levels[levels.length - 1][0];
    }

    function _tiles(uint256 n) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            t[i] = _tileHash(i);
        }
    }

    function _two(address a, address b) internal pure returns (address[] memory arr) {
        arr = new address[](2);
        arr[0] = a;
        arr[1] = b;
    }

    function _sign(bytes32 digest, uint256 key) internal pure returns (bytes memory) {
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }
}
