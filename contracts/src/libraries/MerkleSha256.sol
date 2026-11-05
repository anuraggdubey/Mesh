// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice SHA-256 Merkle tree exactly as defined in docs/job-spec.md section 7.1.
///   leaf(i)    = sha256(0x00 || uint16_be(i) || tileHash || owner(20 bytes))
///   node(l, r) = sha256(0x01 || l || r)
/// Proofs list sibling hashes from the leaf level upward; bit L of the index selects left/right.
library MerkleSha256 {
    function leaf(uint16 index, bytes32 tileHash, address owner) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x00), index, tileHash, owner));
    }

    function node(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x01), left, right));
    }

    function computeRoot(bytes32 leafHash, uint256 index, bytes32[] memory proof) internal pure returns (bytes32 h) {
        h = leafHash;
        for (uint256 i = 0; i < proof.length; i++) {
            if (((index >> i) & 1) == 0) {
                h = node(h, proof[i]);
            } else {
                h = node(proof[i], h);
            }
        }
    }

    /// @dev number of levels for a perfect tree with `leafCount` leaves (leafCount must be a power of two >= 1)
    function depth(uint256 leafCount) internal pure returns (uint256 d) {
        while ((uint256(1) << d) < leafCount) d++;
    }

    function isPowerOfTwo(uint256 x) internal pure returns (bool) {
        return x != 0 && (x & (x - 1)) == 0;
    }
}
