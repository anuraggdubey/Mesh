// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {MeshEscrow} from "../src/MeshEscrow.sol";
import {IMeshEscrow} from "../src/interfaces/IMeshEscrow.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

contract MeshEscrowTest is Base {
    bytes32 constant JOB = bytes32("job-1");
    bytes32 constant JOB2 = bytes32("job-2");

    function test_lock_requiresPaymentToHaveArrived() public {
        vm.prank(api);
        vm.expectRevert(MeshEscrow.PaymentNotReceived.selector);
        escrow.lock(JOB, requester, PRICE); // nothing was paid
    }

    function test_lock_onlyApi() public {
        token.mint(address(escrow), PRICE);
        vm.expectRevert(MeshEscrow.NotApi.selector);
        escrow.lock(JOB, requester, PRICE);
    }

    function test_lock_zeroReverts() public {
        vm.prank(api);
        vm.expectRevert(MeshEscrow.ZeroAmount.selector);
        escrow.lock(JOB, requester, 0);
    }

    function test_lock_twiceReverts() public {
        _payAndLock(JOB, PRICE);
        token.mint(address(escrow), PRICE);
        vm.prank(api);
        vm.expectRevert(MeshEscrow.AlreadyLocked.selector);
        escrow.lock(JOB, requester, PRICE);
    }

    function test_lock_cannotReuseOneBalanceForTwoJobs() public {
        _payAndLock(JOB, PRICE);
        vm.prank(api);
        vm.expectRevert(MeshEscrow.PaymentNotReceived.selector);
        escrow.lock(JOB2, requester, PRICE); // balance only covers the first job
        assertEq(escrow.held(), PRICE);
    }

    function test_release_onlyReceipt() public {
        _payAndLock(JOB, PRICE);
        vm.expectRevert(MeshEscrow.NotReceipt.selector);
        escrow.release(JOB, _two(p1, p2));
        vm.prank(api);
        vm.expectRevert(MeshEscrow.NotReceipt.selector);
        escrow.release(JOB, _two(p1, p2));
    }

    function test_release_splitsEvenly_remainderToFirst() public {
        _payAndLock(JOB, 1001);
        vm.prank(address(receipt));
        escrow.release(JOB, _two(p1, p2));
        assertEq(token.balanceOf(p1), 501);
        assertEq(token.balanceOf(p2), 500);
        assertEq(escrow.held(), 0);
        assertEq(uint8(escrow.statusOf(JOB)), uint8(IMeshEscrow.EscrowStatus.Released));
    }

    function testFuzz_release_conservesFunds(uint96 amount, uint8 nSeed) public {
        uint256 amt = bound(uint256(amount), 1, type(uint96).max);
        uint256 n = bound(uint256(nSeed), 1, 16);
        _payAndLock(JOB, amt);
        address[] memory provs = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            provs[i] = address(uint160(0x1000 + i));
        }
        vm.prank(address(receipt));
        escrow.release(JOB, provs);
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            sum += token.balanceOf(provs[i]);
        }
        assertEq(sum, amt); // nothing created or lost
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.held(), 0);
    }

    function test_release_noProviders() public {
        _payAndLock(JOB, PRICE);
        address[] memory none = new address[](0);
        vm.prank(address(receipt));
        vm.expectRevert(MeshEscrow.NoProviders.selector);
        escrow.release(JOB, none);
    }

    function test_release_twiceReverts_noDoubleRelease() public {
        _payAndLock(JOB, PRICE);
        vm.startPrank(address(receipt));
        escrow.release(JOB, _two(p1, p2));
        vm.expectRevert(MeshEscrow.NotLocked.selector);
        escrow.release(JOB, _two(p1, p2));
        vm.stopPrank();
        assertEq(token.balanceOf(p1) + token.balanceOf(p2), PRICE);
    }

    function test_refund_byReceiptAndApi() public {
        _payAndLock(JOB, PRICE);
        _payAndLock(JOB2, PRICE);
        vm.prank(address(receipt));
        escrow.refund(JOB);
        vm.prank(api);
        escrow.refund(JOB2);
        assertEq(token.balanceOf(requester), 2 * PRICE);
        assertEq(escrow.held(), 0);
    }

    function test_refund_strangerBlockedUntilExpiry() public {
        _payAndLock(JOB, PRICE);
        vm.prank(stranger);
        vm.expectRevert(MeshEscrow.NotAuthorizedToRefund.selector);
        escrow.refund(JOB);

        vm.warp(block.timestamp + REFUND_AFTER);
        vm.prank(stranger);
        escrow.refund(JOB);
        assertEq(token.balanceOf(requester), PRICE);
    }

    function test_releaseAndRefund_mutuallyExclusive() public {
        _payAndLock(JOB, PRICE);
        _payAndLock(JOB2, PRICE);

        vm.startPrank(address(receipt));
        escrow.release(JOB, _two(p1, p2));
        vm.expectRevert(MeshEscrow.NotLocked.selector);
        escrow.refund(JOB); // released -> cannot refund

        escrow.refund(JOB2);
        vm.expectRevert(MeshEscrow.NotLocked.selector);
        escrow.release(JOB2, _two(p1, p2)); // refunded -> cannot release
        vm.stopPrank();
    }

    function test_setReceipt_onceAndOnlyOwner() public {
        MeshEscrow e = new MeshEscrow(IERC20(address(token)), api, 1);
        vm.prank(stranger);
        vm.expectRevert(MeshEscrow.NotOwner.selector);
        e.setReceipt(address(1));
        e.setReceipt(address(1));
        vm.expectRevert(MeshEscrow.ReceiptAlreadySet.selector);
        e.setReceipt(address(2));
    }
}
