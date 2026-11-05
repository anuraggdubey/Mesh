// generated from contracts/out (forge build). Do not edit by hand.
export const meshReceiptAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "api_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "verifier_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "stake_",
        "type": "address",
        "internalType": "contract IMeshStake"
      },
      {
        "name": "escrow_",
        "type": "address",
        "internalType": "contract IMeshEscrow"
      },
      {
        "name": "ogSigner_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "windowSeconds_",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "minStake_",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "slashAmount_",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "receive",
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "MAX_PROVIDERS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_TILES",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "REASON_FRAUD",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "api",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "computeLeaf",
    "inputs": [
      {
        "name": "index",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "tileHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "tileOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "escrow",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IMeshEscrow"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "finalize",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getReceipt",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct MeshReceipt.Receipt",
        "components": [
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum MeshReceipt.Status"
          },
          {
            "name": "requester",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "imageDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "inputHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "merkleRoot",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "postedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "windowEnd",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "attestationDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "zeroGRequestId",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "minStake",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ogSigner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "postAttested",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "requester",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "provider",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "outputDigest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "zeroGRequestId",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "teeSignature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "postClaim",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "requester",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "imageDigest",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "inputHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "providers",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "tileCount",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "postFraud",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "tileIndex",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "tileOwner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expectedTileHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "claimedTileHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "proof",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "providersOf",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setConfig",
    "inputs": [
      {
        "name": "ogSigner_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "windowSeconds_",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "minStake_",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "slashAmount_",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "slashAmount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "stake",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IMeshStake"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "tileCountOf",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "verifier",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "verifyTile",
    "inputs": [
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "tileHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "tileOwner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "proof",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "windowSeconds",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "withdrawRetained",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "internalType": "address payable"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "AttestedPosted",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "outputDigest",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "zeroGRequestId",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClaimPosted",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "requester",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "merkleRoot",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "windowEnd",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FraudProven",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "tileIndex",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ReceiptFinal",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SlashDistributed",
    "inputs": [
      {
        "name": "jobId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "toRequester",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "toVerifier",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "retained",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyPosted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadProof",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadProviders",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadTileCount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadTileIndex",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotApi",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotEligible",
    "inputs": [
      {
        "name": "provider",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotFraud",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotPaid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotPending",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotTileOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotVerifier",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Reentrancy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WindowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WindowOpen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongSigner",
    "inputs": []
  }
] as const;
