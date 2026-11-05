// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {MeshStake} from "../src/MeshStake.sol";

contract MeshStakeTest is Base {
    bytes32 constant N1 = bytes32(uint256(1));
    bytes32 constant N2 = bytes32(uint256(2));

    function test_register_onlyApi() public {
        vm.expectRevert(MeshStake.NotApi.selector);
        stake.registerProvider(p1, N1);
    }

    function test_register_oneProfilePerHuman() public {
        vm.startPrank(api);
        stake.registerProvider(p1, N1);
        vm.expectRevert(MeshStake.NullifierUsed.selector);
        stake.registerProvider(p2, N1); // same human, second wallet
        vm.expectRevert(MeshStake.AlreadyRegistered.selector);
        stake.registerProvider(p1, N2); // same wallet twice
        vm.stopPrank();
    }

    function test_stake_requiresRegistration() public {
        vm.deal(p1, 20 ether);
        vm.prank(p1);
        vm.expectRevert(MeshStake.NotRegistered.selector);
        stake.stake{value: 10 ether}();
    }

    function test_stake_zeroReverts() public {
        vm.prank(api);
        stake.registerProvider(p1, N1);
        vm.prank(p1);
        vm.expectRevert(MeshStake.ZeroAmount.selector);
        stake.stake{value: 0}();
    }

    function test_stake_and_eligibility() public {
        _registerAndStake(p1, N1, 10 ether);
        assertEq(stake.stakeOf(p1), 10 ether);
        assertTrue(stake.isEligible(p1, 10 ether));
        assertFalse(stake.isEligible(p1, 10 ether + 1));
        assertFalse(stake.isEligible(p2, 1)); // never registered
    }

    function test_unstake_flow_and_delay() public {
        _registerAndStake(p1, N1, 10 ether);

        vm.prank(p1);
        vm.expectRevert(MeshStake.NotRequested.selector);
        stake.unstake(1 ether);

        vm.prank(p1);
        stake.requestUnstake();
        vm.prank(p1);
        vm.expectRevert(MeshStake.StillLocked.selector);
        stake.unstake(1 ether);

        vm.warp(block.timestamp + UNLOCK_DELAY);
        vm.prank(p1);
        stake.unstake(4 ether);
        assertEq(stake.stakeOf(p1), 6 ether);
        assertEq(p1.balance, 4 ether);
    }

    function test_unstake_cannotExceedStake() public {
        _registerAndStake(p1, N1, 10 ether);
        vm.prank(p1);
        stake.requestUnstake();
        vm.warp(block.timestamp + UNLOCK_DELAY);
        vm.prank(p1);
        vm.expectRevert(MeshStake.InsufficientStake.selector);
        stake.unstake(11 ether);
    }

    function test_unstake_blockedWhileClaimPending() public {
        _registerAndStake(p1, N1, 10 ether);
        vm.prank(address(receipt));
        stake.extendLock(p1, uint64(block.timestamp + 1000));

        vm.prank(p1);
        stake.requestUnstake();
        vm.warp(block.timestamp + UNLOCK_DELAY + 1); // delay passed but claim window still open
        vm.prank(p1);
        vm.expectRevert(MeshStake.StillLocked.selector);
        stake.unstake(1 ether);

        vm.warp(block.timestamp + 1000);
        vm.prank(p1);
        stake.unstake(1 ether);
    }

    function test_extendLock_onlyReceipt() public {
        vm.expectRevert(MeshStake.NotReceipt.selector);
        stake.extendLock(p1, 123);
    }

    function test_slash_onlyReceipt() public {
        _registerAndStake(p1, N1, 10 ether);
        vm.expectRevert(MeshStake.NotReceipt.selector);
        stake.slash(p1, bytes32("job"), 1 ether, "FRAUD");
    }

    function test_slash_movesFundsToReceipt_andCaps() public {
        _registerAndStake(p1, N1, 10 ether);
        vm.prank(address(receipt));
        uint256 s = stake.slash(p1, bytes32("job1"), 4 ether, "FRAUD");
        assertEq(s, 4 ether);
        assertEq(stake.stakeOf(p1), 6 ether);
        assertEq(address(receipt).balance, 4 ether);

        // asking for more than remains slashes only what is left
        vm.prank(address(receipt));
        s = stake.slash(p1, bytes32("job2"), 100 ether, "FRAUD");
        assertEq(s, 6 ether);
        assertEq(stake.stakeOf(p1), 0);
    }

    function test_slash_sameJobTwiceReverts() public {
        _registerAndStake(p1, N1, 10 ether);
        vm.startPrank(address(receipt));
        stake.slash(p1, bytes32("job"), 1 ether, "FRAUD");
        vm.expectRevert(MeshStake.AlreadySlashed.selector);
        stake.slash(p1, bytes32("job"), 1 ether, "FRAUD");
        vm.stopPrank();
    }

    function test_setReceipt_onceAndOnlyOwner() public {
        MeshStake s = new MeshStake(api, 1);
        vm.prank(stranger);
        vm.expectRevert(MeshStake.NotOwner.selector);
        s.setReceipt(address(1));
        s.setReceipt(address(1));
        vm.expectRevert(MeshStake.ReceiptAlreadySet.selector);
        s.setReceipt(address(2));
    }
}
