package main

import (
	"encoding/hex"
	"testing"
)

func TestMulShiftFloorUsesArithmeticFloor(t *testing.T) {
	if got := mulShiftFloor(-1, 1, fractionBits); got != -1 {
		t.Fatalf("mulShiftFloor(-1, 1, 32) = %d, want -1", got)
	}
	if got := mulShiftFloor(-1, -1, fractionBits); got != 0 {
		t.Fatalf("mulShiftFloor(-1, -1, 32) = %d, want 0", got)
	}
	if got := mulShiftFloor(3<<31, 2<<32, fractionBits); got != 3<<32 {
		t.Fatalf("Q32.32 multiplication = %d, want %d", got, int64(3)<<32)
	}
}

func TestIterationCountEscapeAndInterior(t *testing.T) {
	if got := iterationCount(0, 0, 5); got != 5 {
		t.Fatalf("origin iteration count = %d, want 5", got)
	}
	if got := iterationCount(2<<32, 0, 5); got != 2 {
		t.Fatalf("(2,0) iteration count = %d, want 2", got)
	}
}

func TestRenderTileWritesRowMajorUint16LittleEndian(t *testing.T) {
	config := renderConfig{
		width: 2, height: 2, gridCols: 1, gridRows: 1,
		x0: 0, y0: 0, step: 3 << 31, maxIter: 5,
	}
	got, err := renderTile(config, 0)
	if err != nil {
		t.Fatal(err)
	}
	if encoded := hex.EncodeToString(got); encoded != "0500020002000100" {
		t.Fatalf("tile bytes = %s, want 0500020002000100", encoded)
	}
}

func TestValidateRejectsInvalidGridAndDuplicateTiles(t *testing.T) {
	base := input{
		Spec: "render-v1", Width: 64, Height: 64, GridCols: 2, GridRows: 2,
		X0: "-8589934592", Y0: "-6442450944", Step: "201326592", MaxIter: 500, Tiles: []int{0},
	}
	if _, err := validate(base); err != nil {
		t.Fatalf("valid tiny input rejected: %v", err)
	}

	duplicate := base
	duplicate.Tiles = []int{0, 0}
	if _, err := validate(duplicate); err == nil {
		t.Fatal("duplicate tile indexes should be rejected")
	}

	invalidStep := base
	invalidStep.Step = "201326593"
	if _, err := validate(invalidStep); err == nil {
		t.Fatal("inexact step should be rejected")
	}
}

func TestValidateAllowsLargeWidthWithExactStep(t *testing.T) {
	job := input{
		Spec: "render-v1", Width: 1 << 30, Height: 1 << 10, GridCols: 1 << 8, GridRows: 1 << 8,
		X0: "-8589934592", Y0: "-6442450944", Step: "12", MaxIter: 1, Tiles: []int{0},
	}
	if _, err := validate(job); err != nil {
		t.Fatalf("valid exact-step dimensions rejected: %v", err)
	}
}
