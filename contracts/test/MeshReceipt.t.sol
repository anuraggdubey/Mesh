// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {MeshReceipt} from "../src/MeshReceipt.sol";
import {MeshStake} from "../src/MeshStake.sol";
import {MeshEscrow} from "../src/MeshEscrow.sol";
import {IMeshEscrow} from "../src/interfaces/IMeshEscrow.sol";
import {MerkleSha256} from "../src/libraries/MerkleSha256.sol";

contract MeshReceiptTest is Base {
    bytes32 constant JOB = bytes32("job-1");
    bytes32 constant IMG = bytes32("image-digest");
    bytes32 constant INP = bytes32("input-hash");
    uint16 constant N = 8;

    bytes32[] tiles;
    bytes32[][] levels;
    bytes32 root;

    function setUp() public override {
        super.setUp();
        _registerAndStake(p1, bytes32(uint256(1)), 10 ether);
        _registerAndStake(p2, bytes32(uint256(2)), 10 ether);
        _payAndLock(JOB, PRICE);

        bytes32[] memory t = _tiles(N);
        for (uint256 i = 0; i < N; i++) {
            tiles.push(t[i]);
        }
        levels = _buildTree(t, _two(p1, p2));
        root = _root(levels);
    }

    function _post() internal {
        vm.prank(api);
        receipt.postClaim(JOB, requester, IMG, INP, root, _two(p1, p2), N);
    }

    // ───────── postClaim ─────────

    function test_postClaim_happy() public {
        _post();
        MeshReceipt.Receipt memory r = receipt.getReceipt(JOB);
        assertEq(uint8(r.status), uint8(MeshReceipt.Status.Pending));
        assertEq(r.merkleRoot, root);
        assertEq(r.requester, requester);
        assertEq(r.windowEnd, uint64(block.timestamp) + WINDOW);
        assertEq(receipt.providersOf(JOB).length, 2);
        assertEq(receipt.tileCountOf(JOB), N);
    }

    function test_postClaim_onlyApi() public {
        vm.expectRevert(MeshReceipt.NotApi.selector);
        receipt.postClaim(JOB, requester, IMG, INP, root, _two(p1, p2), N);
    }

    function test_postClaim_replayRejected() public {
        _post();
        vm.prank(api);
        vm.expectRevert(MeshReceipt.AlreadyPosted.selector);
        receipt.postClaim(JOB, requester, IMG, INP, root, _two(p1, p2), N);
    }

    function test_postClaim_requiresPayment() public {
        vm.prank(api);
        vm.expectRevert(MeshReceipt.NotPaid.selector);
        receipt.postClaim(bytes32("unpaid"), requester, IMG, INP, root, _two(p1, p2), N);
    }

    function test_postClaim_requiresEligibleProviders() public {
        vm.prank(api);
        vm.expectRevert(abi.encodeWithSelector(MeshReceipt.NotEligible.selector, stranger));
        receipt.postClaim(JOB, requester, IMG, INP, root, _two(p1, stranger), N);
    }

    function test_postClaim_rejectsUnderstaked() public {
        address p3 = makeAddr("p3");
        _registerAndStake(p3, bytes32(uint256(3)), 1 ether); // below MIN_STAKE
        vm.prank(api);
        vm.expectRevert(abi.encodeWithSelector(MeshReceipt.NotEligible.selector, p3));
        receipt.postClaim(JOB, requester, IMG, INP, root, _two(p1, p3), N);
    }

    function test_postClaim_badTileCount() public {
        vm.startPrank(api);
        vm.expectRevert(MeshReceipt.BadTileCount.selector);
        receipt.postClaim(JOB, requester, IMG, INP, root, _two(p1, p2), 6); // not a power of two
        vm.expectRevert(MeshReceipt.BadTileCount.selector);
        receipt.postClaim(JOB, requester, IMG, INP, root, _two(p1, p2), 0);
        vm.stopPrank();
    }

    function test_postClaim_badProviders() public {
        vm.startPrank(api);
        vm.expectRevert(MeshReceipt.BadProviders.selector);
        receipt.postClaim(JOB, requester, IMG, INP, root, _two(p1, p1), N); // duplicate
        address[] memory none = new address[](0);
        vm.expectRevert(MeshReceipt.BadProviders.selector);
        receipt.postClaim(JOB, requester, IMG, INP, root, none, N);
        vm.stopPrank();
    }

    // ───────── finalize / release ─────────

    function test_finalize_beforeWindowReverts() public {
        _post();
        vm.expectRevert(MeshReceipt.WindowOpen.selector);
        receipt.finalize(JOB);
        vm.warp(block.timestamp + WINDOW); // exactly at windowEnd is still open
        vm.expectRevert(MeshReceipt.WindowOpen.selector);
        receipt.finalize(JOB);
    }

    function test_finalize_cannotReleaseWithoutReceipt() public {
        vm.expectRevert(MeshReceipt.NotPending.selector);
        receipt.finalize(JOB);
        // and the escrow itself refuses a direct release from anyone but the receipt contract
        vm.expectRevert(MeshEscrow.NotReceipt.selector);
        escrow.release(JOB, _two(p1, p2));
    }

    function test_finalize_releasesToProviders() public {
        _post();
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(stranger); // anyone may finalize
        receipt.finalize(JOB);

        assertEq(uint8(receipt.getReceipt(JOB).status), uint8(MeshReceipt.Status.Final));
        assertEq(token.balanceOf(p1), PRICE / 2);
        assertEq(token.balanceOf(p2), PRICE / 2);
        assertEq(uint8(escrow.statusOf(JOB)), uint8(IMeshEscrow.EscrowStatus.Released));
    }

    function test_finalize_twiceReverts() public {
        _post();
        vm.warp(block.timestamp + WINDOW + 1);
        receipt.finalize(JOB);
        vm.expectRevert(MeshReceipt.NotPending.selector);
        receipt.finalize(JOB);
    }

    function test_providerCannotUnstakeDuringWindow() public {
        receipt.setConfig(ogSigner, 1000, MIN_STAKE, SLASH); // window (1000s) longer than the unlock delay (100s)
        _post();
        vm.prank(p2);
        stake.requestUnstake();
        vm.warp(block.timestamp + UNLOCK_DELAY + 1); // unlock delay passed, claim window still open
        vm.prank(p2);
        vm.expectRevert(MeshStake.StillLocked.selector);
        stake.unstake(1 ether);

        vm.warp(block.timestamp + 1000); // window over
        vm.prank(p2);
        stake.unstake(1 ether);
        assertEq(stake.stakeOf(p2), 9 ether);
    }

    // ───────── fraud ─────────

    function _fraudArgs(uint16 idx)
        internal
        view
        returns (address owner_, bytes32 expected, bytes32 claimed, bytes32[] memory proof)
    {
        owner_ = idx % 2 == 0 ? p1 : p2;
        claimed = tiles[idx]; // what the provider committed to in the tree
        expected = sha256(abi.encodePacked("the-correct-output", idx)); // what the verifier recomputed
        proof = _proof(levels, idx);
    }

    function test_fraud_slashesOwner_refundsRequester_splitsSlash() public {
        _post();
        (address o, bytes32 exp, bytes32 cl, bytes32[] memory pr) = _fraudArgs(3); // tile 3 -> p2
        assertEq(o, p2);

        vm.prank(verifier);
        receipt.postFraud(JOB, 3, o, exp, cl, pr);

        assertEq(uint8(receipt.getReceipt(JOB).status), uint8(MeshReceipt.Status.Rejected));
        // requester refunded, providers unpaid
        assertEq(token.balanceOf(requester), PRICE);
        assertEq(token.balanceOf(p1) + token.balanceOf(p2), 0);
        assertEq(uint8(escrow.statusOf(JOB)), uint8(IMeshEscrow.EscrowStatus.Refunded));
        // p2 slashed 4 ether: 2 to requester, 1 to verifier, 1 retained by the receipt contract
        assertEq(stake.stakeOf(p2), 6 ether);
        assertEq(stake.stakeOf(p1), 10 ether); // honest provider untouched
        assertEq(requester.balance, 2 ether);
        assertEq(verifier.balance, 1 ether);
        assertEq(address(receipt).balance, 1 ether);
    }

    function test_fraud_onlyVerifier() public {
        _post();
        (address o, bytes32 exp, bytes32 cl, bytes32[] memory pr) = _fraudArgs(3);
        vm.prank(api);
        vm.expectRevert(MeshReceipt.NotVerifier.selector);
        receipt.postFraud(JOB, 3, o, exp, cl, pr);
        vm.prank(stranger);
        vm.expectRevert(MeshReceipt.NotVerifier.selector);
        receipt.postFraud(JOB, 3, o, exp, cl, pr);
    }

    function test_fraud_notWhenHashesEqual() public {
        _post();
        (address o,, bytes32 cl, bytes32[] memory pr) = _fraudArgs(3);
        vm.prank(verifier);
        vm.expectRevert(MeshReceipt.NotFraud.selector);
        receipt.postFraud(JOB, 3, o, cl, cl, pr); // expected == claimed: honest tile cannot be "proven" fraudulent
    }

    function test_fraud_wrongOwnerRejected() public {
        _post();
        (, bytes32 exp, bytes32 cl, bytes32[] memory pr) = _fraudArgs(3);
        vm.prank(verifier);
        vm.expectRevert(MeshReceipt.NotTileOwner.selector);
        receipt.postFraud(JOB, 3, p1, exp, cl, pr); // tile 3 belongs to p2, cannot frame p1
    }

    function test_fraud_badProofRejected() public {
        _post();
        (address o, bytes32 exp, bytes32 cl, bytes32[] memory pr) = _fraudArgs(3);
        pr[0] = bytes32(uint256(pr[0]) ^ 1); // corrupt one sibling
        vm.prank(verifier);
        vm.expectRevert(MeshReceipt.BadProof.selector);
        receipt.postFraud(JOB, 3, o, exp, cl, pr);
    }

    function test_fraud_claimedHashNotInTreeRejected() public {
        _post();
        (address o, bytes32 exp,, bytes32[] memory pr) = _fraudArgs(3);
        vm.prank(verifier);
        vm.expectRevert(MeshReceipt.BadProof.selector);
        receipt.postFraud(JOB, 3, o, exp, bytes32("not-what-was-committed"), pr);
    }

    function test_fraud_wrongProofLengthRejected() public {
        _post();
        (address o, bytes32 exp, bytes32 cl,) = _fraudArgs(3);
        bytes32[] memory short = new bytes32[](2);
        vm.prank(verifier);
        vm.expectRevert(MeshReceipt.BadProof.selector);
        receipt.postFraud(JOB, 3, o, exp, cl, short);
    }

    function test_fraud_badIndexRejected() public {
        _post();
        (address o, bytes32 exp, bytes32 cl, bytes32[] memory pr) = _fraudArgs(3);
        vm.prank(verifier);
        vm.expectRevert(MeshReceipt.BadTileIndex.selector);
        receipt.postFraud(JOB, N, o, exp, cl, pr);
    }

    function test_fraud_afterWindowRejected() public {
        _post();
        (address o, bytes32 exp, bytes32 cl, bytes32[] memory pr) = _fraudArgs(3);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(verifier);
        vm.expectRevert(MeshReceipt.WindowClosed.selector);
        receipt.postFraud(JOB, 3, o, exp, cl, pr);
    }

    function test_fraud_thenFinalizeBlocked_noPayout() public {
        _post();
        (address o, bytes32 exp, bytes32 cl, bytes32[] memory pr) = _fraudArgs(0);
        vm.prank(verifier);
        receipt.postFraud(JOB, 0, o, exp, cl, pr);

        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(MeshReceipt.NotPending.selector);
        receipt.finalize(JOB);
        assertEq(token.balanceOf(p1) + token.balanceOf(p2), 0);
    }

    function test_fraud_twiceReverts() public {
        _post();
        (address o, bytes32 exp, bytes32 cl, bytes32[] memory pr) = _fraudArgs(3);
        vm.startPrank(verifier);
        receipt.postFraud(JOB, 3, o, exp, cl, pr);
        vm.expectRevert(MeshReceipt.NotPending.selector);
        receipt.postFraud(JOB, 3, o, exp, cl, pr);
        vm.stopPrank();
    }

    function test_fraud_slashCappedAtRemainingStake() public {
        receipt.setConfig(ogSigner, WINDOW, MIN_STAKE, 50 ether); // slash amount far above p2's 10 ether stake
        _post();
        (address o, bytes32 exp, bytes32 cl, bytes32[] memory pr) = _fraudArgs(3); // owner p2
        vm.prank(verifier);
        receipt.postFraud(JOB, 3, o, exp, cl, pr);

        assertEq(stake.stakeOf(p2), 0); // only what existed was taken
        assertEq(requester.balance, 5 ether);
        assertEq(verifier.balance, 2.5 ether);
        assertEq(address(receipt).balance, 2.5 ether);
    }

    function test_slashedProvider_cannotJoinNewClaim() public {
        vm.prank(address(receipt));
        stake.slash(p2, bytes32("earlier"), 8 ether, "FRAUD"); // p2 now below MIN_STAKE
        vm.prank(api);
        vm.expectRevert(abi.encodeWithSelector(MeshReceipt.NotEligible.selector, p2));
        receipt.postClaim(JOB, requester, IMG, INP, root, _two(p1, p2), N);
    }

    // ───────── Merkle encoding ─────────

    function test_merkle_leafEncodingMatchesSpec() public view {
        bytes32 expected = sha256(abi.encodePacked(bytes1(0x00), uint16(5), bytes32(uint256(42)), p1));
        assertEq(receipt.computeLeaf(5, bytes32(uint256(42)), p1), expected);
    }

    function test_merkle_everyLeafVerifies_andWrongOwnerFails() public view {
        for (uint256 i = 0; i < N; i++) {
            address o = i % 2 == 0 ? p1 : p2;
            assertTrue(receipt.verifyTile(root, uint16(i), tiles[i], o, _proof(levels, i)));
            address other = i % 2 == 0 ? p2 : p1;
            assertFalse(receipt.verifyTile(root, uint16(i), tiles[i], other, _proof(levels, i)));
        }
    }

    function test_merkle_64TileTree() public {
        bytes32[] memory t = _tiles(64);
        bytes32[][] memory lv = _buildTree(t, _two(p1, p2));
        assertEq(lv.length, 7); // depth 6
        bytes32 r = _root(lv);
        for (uint256 i = 0; i < 64; i += 7) {
            assertTrue(receipt.verifyTile(r, uint16(i), t[i], i % 2 == 0 ? p1 : p2, _proof(lv, i)));
        }
    }

    function testFuzz_merkle_proofRoundTrip_andTamperFails(uint8 idxSeed, bytes32 salt, uint8 bit) public view {
        bytes32[] memory t = new bytes32[](64);
        for (uint256 i = 0; i < 64; i++) {
            t[i] = sha256(abi.encodePacked(salt, i));
        }
        bytes32[][] memory lv = _buildTree(t, _two(p1, p2));
        bytes32 r = _root(lv);
        uint256 idx = idxSeed % 64;
        address o = idx % 2 == 0 ? p1 : p2;

        assertTrue(receipt.verifyTile(r, uint16(idx), t[idx], o, _proof(lv, idx)));

        bytes32 flipped = bytes32(uint256(t[idx]) ^ (uint256(1) << (bit % 256)));
        assertFalse(receipt.verifyTile(r, uint16(idx), flipped, o, _proof(lv, idx)));
    }

    // ───────── attested (0G) ─────────

    function test_attested_validSignatureReleases() public {
        bytes32 digest = sha256("inference output");
        bytes memory sig = _sign(digest, ogKey);
        vm.prank(api);
        receipt.postAttested(JOB, requester, p1, digest, "0g-req-123", sig);

        MeshReceipt.Receipt memory r = receipt.getReceipt(JOB);
        assertEq(uint8(r.status), uint8(MeshReceipt.Status.Attested));
        assertEq(r.zeroGRequestId, "0g-req-123");
        assertEq(r.attestationDigest, digest);
        assertEq(token.balanceOf(p1), PRICE);
    }

    function test_attested_wrongSignerRejected() public {
        bytes32 digest = sha256("inference output");
        bytes memory sig = _sign(digest, 0xBAD);
        vm.prank(api);
        vm.expectRevert(MeshReceipt.WrongSigner.selector);
        receipt.postAttested(JOB, requester, p1, digest, "x", sig);
        assertEq(token.balanceOf(p1), 0);
    }

    function test_attested_tamperedDigestRejected() public {
        bytes32 digest = sha256("inference output");
        bytes memory sig = _sign(digest, ogKey);
        bytes32 tampered = sha256("tampered output"); // computed before expectRevert (sha256 is itself a call)
        vm.prank(api);
        vm.expectRevert(MeshReceipt.WrongSigner.selector);
        receipt.postAttested(JOB, requester, p1, tampered, "x", sig);
    }

    function test_attested_garbageSignatureRejected() public {
        vm.prank(api);
        vm.expectRevert(MeshReceipt.BadSignature.selector);
        receipt.postAttested(JOB, requester, p1, bytes32("d"), "x", hex"1234");
    }

    function test_attested_replayRejected() public {
        bytes32 digest = sha256("inference output");
        bytes memory sig = _sign(digest, ogKey);
        vm.startPrank(api);
        receipt.postAttested(JOB, requester, p1, digest, "x", sig);
        vm.expectRevert(MeshReceipt.AlreadyPosted.selector);
        receipt.postAttested(JOB, requester, p1, digest, "x", sig);
        vm.stopPrank();
    }

    function test_attested_requiresPaymentAndEligibleProvider() public {
        bytes32 digest = sha256("o");
        bytes memory sig = _sign(digest, ogKey);
        vm.startPrank(api);
        vm.expectRevert(MeshReceipt.NotPaid.selector);
        receipt.postAttested(bytes32("unpaid"), requester, p1, digest, "x", sig);
        vm.expectRevert(abi.encodeWithSelector(MeshReceipt.NotEligible.selector, stranger));
        receipt.postAttested(JOB, requester, stranger, digest, "x", sig);
        vm.stopPrank();
    }

    function test_attested_onlyApi() public {
        bytes32 digest = sha256("o");
        bytes memory sig = _sign(digest, ogKey);
        vm.expectRevert(MeshReceipt.NotApi.selector);
        receipt.postAttested(JOB, requester, p1, digest, "x", sig);
    }

    function test_attested_zeroSignatureNeverMatchesUnsetSigner() public {
        receipt.setConfig(address(0), WINDOW, MIN_STAKE, SLASH); // signer not configured
        bytes32 digest = sha256("o");
        // an all-zero signature recovers address(0); it must be rejected, not treated as the unset signer
        vm.prank(api);
        vm.expectRevert(MeshReceipt.BadSignature.selector);
        receipt.postAttested(JOB, requester, p1, digest, "x", new bytes(65));
    }

    // ───────── admin ─────────

    function test_setConfig_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(MeshReceipt.NotOwner.selector);
        receipt.setConfig(address(1), 1, 1, 1);
    }

    function test_withdrawRetained_onlyOwner() public {
        vm.deal(address(receipt), 1 ether);
        vm.prank(stranger);
        vm.expectRevert(MeshReceipt.NotOwner.selector);
        receipt.withdrawRetained(payable(stranger), 1 ether);
        receipt.withdrawRetained(payable(address(this)), 1 ether);
    }

    receive() external payable {}
}
