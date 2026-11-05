package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"math/bits"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
)

const (
	fractionBits     = 32
	maxTreeTileCount = 1 << 16
	maxPixelsPerTile = 32 << 20
	fixedThree       = int64(3) << fractionBits
	fixedFour        = int64(4) << fractionBits
	inputPath        = "/input/job.json"
	outputDirectory  = "/output"
)

type input struct {
	Spec     string `json:"spec"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	GridCols int    `json:"gridCols"`
	GridRows int    `json:"gridRows"`
	X0       string `json:"x0"`
	Y0       string `json:"y0"`
	Step     string `json:"step"`
	MaxIter  int    `json:"maxIter"`
	Tiles    []int  `json:"tiles"`
}

type renderConfig struct {
	width    int
	height   int
	gridCols int
	gridRows int
	x0       int64
	y0       int64
	step     int64
	maxIter  int
	tiles    []int
}

func main() {
	inputFile := flag.String("input", inputPath, "path to the render job JSON")
	outputDir := flag.String("output", outputDirectory, "directory for rendered tile files")
	flag.Parse()

	if err := run(*inputFile, *outputDir); err != nil {
		fmt.Fprintf(os.Stderr, "mesh-render: %v\n", err)
		os.Exit(1)
	}
}

func run(inputFile, outputDir string) error {
	data, err := os.ReadFile(inputFile)
	if err != nil {
		return fmt.Errorf("read %s: %w", inputFile, err)
	}

	var job input
	if err := json.Unmarshal(data, &job); err != nil {
		return fmt.Errorf("decode job input: %w", err)
	}
	config, err := validate(job)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return fmt.Errorf("prepare output directory: %w", err)
	}

	for _, tileIndex := range config.tiles {
		data, err := renderTile(config, tileIndex)
		if err != nil {
			return fmt.Errorf("render tile %d: %w", tileIndex, err)
		}
		path := filepath.Join(outputDir, fmt.Sprintf("tile-%d.bin", tileIndex))
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return fmt.Errorf("write tile %d: %w", tileIndex, err)
		}
	}

	return nil
}

func validate(job input) (renderConfig, error) {
	if job.Spec != "render-v1" {
		return renderConfig{}, fmt.Errorf("spec must be render-v1")
	}
	if !isPowerOfTwo(job.Width) || !isPowerOfTwo(job.Height) {
		return renderConfig{}, errors.New("width and height must be positive powers of two")
	}
	if !isPowerOfTwo(job.GridCols) || !isPowerOfTwo(job.GridRows) {
		return renderConfig{}, errors.New("gridCols and gridRows must be positive powers of two")
	}
	if job.Width%job.GridCols != 0 || job.Height%job.GridRows != 0 {
		return renderConfig{}, errors.New("grid dimensions must divide the image dimensions")
	}
	if job.GridCols > maxTreeTileCount/job.GridRows {
		return renderConfig{}, fmt.Errorf("tile count cannot exceed %d", maxTreeTileCount)
	}
	tileCount := job.GridCols * job.GridRows
	tileW := job.Width / job.GridCols
	tileH := job.Height / job.GridRows
	if tileW > maxPixelsPerTile/tileH {
		return renderConfig{}, fmt.Errorf("tile dimensions exceed the %d-pixel safety limit", maxPixelsPerTile)
	}
	if job.MaxIter < 1 || job.MaxIter > math.MaxUint16 {
		return renderConfig{}, errors.New("maxIter must be between 1 and 65535")
	}
	if int64(job.Width) > int64(1)<<fractionBits {
		return renderConfig{}, errors.New("width must be at most 2^32 for an exact positive fixed-point step")
	}

	x0, err := strconv.ParseInt(job.X0, 10, 64)
	if err != nil {
		return renderConfig{}, fmt.Errorf("x0 must be a signed 64-bit decimal integer: %w", err)
	}
	y0, err := strconv.ParseInt(job.Y0, 10, 64)
	if err != nil {
		return renderConfig{}, fmt.Errorf("y0 must be a signed 64-bit decimal integer: %w", err)
	}
	step, err := strconv.ParseInt(job.Step, 10, 64)
	if err != nil {
		return renderConfig{}, fmt.Errorf("step must be a signed 64-bit decimal integer: %w", err)
	}
	if step != fixedThree/int64(job.Width) {
		return renderConfig{}, errors.New("step must equal 3*2^32/width")
	}
	if len(job.Tiles) == 0 {
		return renderConfig{}, errors.New("tiles must contain at least one tile index")
	}

	seen := make(map[int]struct{}, len(job.Tiles))
	for _, tileIndex := range job.Tiles {
		if tileIndex < 0 || tileIndex >= tileCount {
			return renderConfig{}, fmt.Errorf("tile index %d is outside [0,%d)", tileIndex, tileCount)
		}
		if _, exists := seen[tileIndex]; exists {
			return renderConfig{}, fmt.Errorf("tile index %d appears more than once", tileIndex)
		}
		seen[tileIndex] = struct{}{}
	}

	return renderConfig{
		width: job.Width, height: job.Height,
		gridCols: job.GridCols, gridRows: job.GridRows,
		x0: x0, y0: y0, step: step, maxIter: job.MaxIter,
		tiles: append([]int(nil), job.Tiles...),
	}, nil
}

func isPowerOfTwo(value int) bool {
	return value > 0 && value&(value-1) == 0
}

func renderTile(config renderConfig, tileIndex int) ([]byte, error) {
	tileW := config.width / config.gridCols
	tileH := config.height / config.gridRows
	output := make([]byte, tileW*tileH*2)
	rowJobs := make(chan int, tileH)
	workerCount := runtime.GOMAXPROCS(0)
	if workerCount > tileH {
		workerCount = tileH
	}

	var workers sync.WaitGroup
	workers.Add(workerCount)
	for worker := 0; worker < workerCount; worker++ {
		go func() {
			defer workers.Done()
			for localY := range rowJobs {
				py := (tileIndex/config.gridCols)*tileH + localY
				cy := config.y0 + int64(py)*config.step
				for localX := 0; localX < tileW; localX++ {
					px := (tileIndex%config.gridCols)*tileW + localX
					cx := config.x0 + int64(px)*config.step
					iterations := iterationCount(cx, cy, config.maxIter)
					pixelOffset := (localY*tileW + localX) * 2
					binary.LittleEndian.PutUint16(output[pixelOffset:pixelOffset+2], iterations)
				}
			}
		}()
	}

	for row := 0; row < tileH; row++ {
		rowJobs <- row
	}
	close(rowJobs)
	workers.Wait()
	return output, nil
}

func iterationCount(cx, cy int64, maxIter int) uint16 {
	var zr, zi int64
	for n := 0; n < maxIter; n++ {
		zr2 := mulShiftFloor(zr, zr, fractionBits)
		zi2 := mulShiftFloor(zi, zi, fractionBits)
		if zr2+zi2 > fixedFour {
			return uint16(n)
		}

		nextZi := mulShiftFloor(zr, zi, fractionBits-1) + cy
		nextZr := zr2 - zi2 + cx
		zr, zi = nextZr, nextZi
	}
	return uint16(maxIter)
}

// mulShiftFloor computes floor((a*b)/2^shift) with a signed 128-bit product.
func mulShiftFloor(a, b int64, shift uint) int64 {
	negative := (a < 0) != (b < 0)
	abs := func(value int64) uint64 {
		if value < 0 {
			return uint64(-(value + 1)) + 1
		}
		return uint64(value)
	}

	hi, lo := bits.Mul64(abs(a), abs(b))
	if hi>>shift != 0 {
		panic("fixed-point product exceeds int64 after scaling")
	}
	quotient := hi<<(64-shift) | lo>>shift
	if negative && lo&((uint64(1)<<shift)-1) != 0 {
		quotient++
	}

	if negative {
		if quotient == uint64(1)<<63 {
			return math.MinInt64
		}
		if quotient > uint64(1)<<63 {
			panic("fixed-point result is below int64 range")
		}
		return -int64(quotient)
	}
	if quotient > math.MaxInt64 {
		panic("fixed-point result exceeds int64 range")
	}
	return int64(quotient)
}
