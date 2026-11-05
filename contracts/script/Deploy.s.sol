// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockStable} from "../src/MockStable.sol";
import {MeshStake} from "../src/MeshStake.sol";
import {MeshEscrow} from "../src/MeshEscrow.sol";
import {MeshReceipt} from "../src/MeshReceipt.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IMeshStake} from "../src/interfaces/IMeshStake.sol";
import {IMeshEscrow} from "../src/interfaces/IMeshEscrow.sol";

/// Deploy order: MockStable (if PAYMENT_TOKEN_ADDRESS unset) -> MeshStake -> MeshEscrow -> MeshReceipt -> wire.
///
/// Env (read from the shell / .env):
///   DEPLOYER_PRIVATE_KEY   0x... hex private key (SECRET, never commit)
///   API_ADDRESS            address of the backend key (calls lock/postClaim/registerProvider/postAttested)
///   VERIFIER_ADDRESS       address of the verifier key (calls postFraud)
///   OG_SIGNER_ADDRESS      0G TEE signer (optional; address(0) until known, set later with setConfig)
///   PAYMENT_TOKEN_ADDRESS  ERC-20 used for escrow (optional; a MockStable is deployed if unset)
///   WINDOW_SECONDS         challenge window (default 45)
///   MIN_STAKE_WEI          minimum provider stake in native units (default 1e18)
///   SLASH_AMOUNT_WEI       stake slashed per fraud (default 5e17)
///   UNLOCK_DELAY_SECONDS   unstake delay (default 300)
///   REFUND_AFTER_SECONDS   public refund timeout (default 3600)
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address api = vm.envAddress("API_ADDRESS");
        address verifier = vm.envAddress("VERIFIER_ADDRESS");
        address ogSigner = vm.envOr("OG_SIGNER_ADDRESS", address(0));
        address tokenAddr = vm.envOr("PAYMENT_TOKEN_ADDRESS", address(0));
        uint64 windowSeconds = uint64(vm.envOr("WINDOW_SECONDS", uint256(45)));
        uint256 minStake = vm.envOr("MIN_STAKE_WEI", uint256(1 ether));
        uint256 slashAmount = vm.envOr("SLASH_AMOUNT_WEI", uint256(0.5 ether));
        uint256 unlockDelay = vm.envOr("UNLOCK_DELAY_SECONDS", uint256(300));
        uint256 refundAfter = vm.envOr("REFUND_AFTER_SECONDS", uint256(3600));

        vm.startBroadcast(deployerKey);

        if (tokenAddr == address(0)) {
            tokenAddr = address(new MockStable());
        }
        MeshStake stake = new MeshStake(api, unlockDelay);
        MeshEscrow escrow = new MeshEscrow(IERC20(tokenAddr), api, refundAfter);
        MeshReceipt receipt = new MeshReceipt(
            api,
            verifier,
            IMeshStake(address(stake)),
            IMeshEscrow(address(escrow)),
            ogSigner,
            windowSeconds,
            minStake,
            slashAmount
        );
        stake.setReceipt(address(receipt));
        escrow.setReceipt(address(receipt));

        vm.stopBroadcast();

        console.log("PAYMENT_TOKEN_ADDRESS=%s", tokenAddr);
        console.log("STAKE_ADDRESS=%s", address(stake));
        console.log("ESCROW_ADDRESS=%s", address(escrow));
        console.log("RECEIPT_ADDRESS=%s", address(receipt));
    }
}
