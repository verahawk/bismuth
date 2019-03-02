// Copyright (c) 2018-2019 Eon S. Jeon <esjeon@hyunmu.am>
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"),
// to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
// THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

/**
 * Maintains tiling context and performs various tiling actions.
 */
class TilingEngine {
    private driver: IDriver;
    private layouts: LayoutStore;
    private windows: Window[];

    constructor(driver: IDriver) {
        this.driver = driver;
        this.layouts = new LayoutStore();
        this.windows = Array();
    }

    public adjustLayout(basis: Window) {
        const ctx = basis.context as KWinContext;
        const layout = this.layouts.getCurrentLayout(ctx);
        if (layout.adjust) {
            const area = this.driver.getWorkingArea(ctx);
            const tiles = this.windows.filter((win) =>
                (win.state === WindowState.Tile) && win.visible(ctx));
            layout.adjust(area, tiles, basis);
        }
    }

    public arrange() {
        debug(() => "arrange");
        this.driver.forEachScreen((ctx: IDriverContext) => {
            this.arrangeScreen(ctx);
        });
    }

    public arrangeScreen(ctx: IDriverContext) {
        const layout = this.layouts.getCurrentLayout(ctx);

        const fullArea = this.driver.getWorkingArea(ctx);
        const workingArea = new Rect(
            fullArea.x + CONFIG.screenGapLeft,
            fullArea.y + CONFIG.screenGapTop,
            fullArea.width - (CONFIG.screenGapLeft + CONFIG.screenGapRight),
            fullArea.height - (CONFIG.screenGapTop + CONFIG.screenGapBottom),
        );

        const visibles = this.windows.filter((win) => win.visible(ctx));
        const tiles = visibles.filter((win) =>
            (win.state === WindowState.Tile) || (win.state === WindowState.FreeTile));
        debugObj(() => ["arrangeScreen", {
            ctx, layout,
            tiles: tiles.length,
            visibles: visibles.length,
        }]);

        /* reset all properties of windows */
        visibles.forEach((window) => {
            if (window.state === WindowState.FreeTile)
                window.state = WindowState.Tile;

            if (window.state === WindowState.Tile)
                window.noBorder = CONFIG.noTileBorder;
        });

        if (CONFIG.maximizeSoleTile && tiles.length === 1) {
            tiles[0].noBorder = true;
            tiles[0].geometry = fullArea;
        } else if (tiles.length > 0)
            layout.apply(tiles, workingArea, fullArea);

        visibles.forEach((window) => window.commit());
    }

    public enforceClientSize(window: Window) {
        if (window.state === WindowState.Tile && !window.actualGeometry.equals(window.geometry))
            KWinSetTimeout(() => {
                if (window.state === WindowState.Tile)
                    window.commit();
            }, 10);
    }

    public manageClient(window: Window) {
        if (!window.shouldIgnore) {
            window.state = (window.shouldFloat) ? WindowState.Float : WindowState.Tile;
            this.windows.push(window);
        }
    }

    public unmanageClient(window: Window) {
        const idx = this.windows.indexOf(window);
        if (idx >= 0)
            this.windows.splice(idx, 1);
    }

    /*
     * User Input Handling
     */

    // TODO: move this to controller
    public handleUserInput(input: UserInput, data?: any) {
        debugObj(() => ["handleUserInput", {input: UserInput[input], data}]);

        const ctx = this.driver.getCurrentContext();

        const layout = this.layouts.getCurrentLayout(ctx);
        if (layout.handleUserInput) {
            const overriden = layout.handleUserInput(input, data);
            if (overriden) {
                this.arrange();
                return;
            }
        }

        let window;
        switch (input) {
            case UserInput.Up:
                this.moveFocus(-1);
                break;
            case UserInput.Down:
                this.moveFocus(+1);
                break;
            case UserInput.ShiftUp:
                this.moveTile(-1);
                break;
            case UserInput.ShiftDown:
                this.moveTile(+1);
                break;
            case UserInput.SetMaster:
                if ((window = this.driver.getCurrentWindow()))
                    this.setMaster(window);
                break;
            case UserInput.Float:
                if ((window = this.driver.getCurrentWindow()))
                    window.state = (window.state === WindowState.Float) ? WindowState.Tile : WindowState.Float;
                break;
            case UserInput.CycleLayout:
                this.cycleLayout();
                break;
            case UserInput.SetLayout:
                this.layouts.setLayout(this.driver.getCurrentContext(), data);
                break;
        }
        this.arrange();
    }

    public moveFocus(step: number) {
        if (step === 0)
            return;

        const window = this.driver.getCurrentWindow();
        const ctx = (window) ? window.context : this.driver.getCurrentContext();

        const visibles = this.windows.filter((win) => win.visible(ctx));
        if (visibles.length === 0) /* nothing to focus */
            return;

        const idx = (window) ? visibles.indexOf(window) : -1;
        if (!window || idx < 0) { /* unmanaged window -> focus master */
            this.driver.setCurrentWindow(visibles[0]);
            return;
        }

        const num = visibles.length;
        const newIndex = (idx + (step % num) + num) % num;

        debugObj(() => ["moveFocus", {from: window, to: visibles[newIndex]}]);
        this.driver.setCurrentWindow(visibles[newIndex]);
    }

    public moveTile(step: number) {
        if (step === 0)
            return;

        const srcWin = this.driver.getCurrentWindow();
        if (!srcWin)
            return;

        const ctx = srcWin.context;
        const visibles = this.windows.filter((win) => win.visible(ctx));
        if (visibles.length < 2)
            return;

        const num = visibles.length;
        const srcIdx = visibles.indexOf(srcWin);
        const destIdx = (srcIdx + (step % num) + num) % num;
        debugObj(() => ["moveTile", {num, srcIdx, step, destIdx}]);
        if (srcIdx === destIdx)
            return;

        const destWin = visibles[destIdx];

        debugObj(() => ["moveTile", {srcWin, destWin}]);
        const srcListIdx = this.windows.indexOf(srcWin);
        const destListIdx = this.windows.indexOf(destWin);
        this.windows[destListIdx] = srcWin ;
        this.windows[srcListIdx] = destWin;
    }

    public setMaster(window: Window) {
        if (this.windows[0] === window)
            return;

        const idx = this.windows.indexOf(window);
        if (idx < 0)
            return;

        debugObj(() => ["setMaster", {to: window}]);
        this.windows.splice(idx, 1);
        this.windows.unshift(window);
    }

    public cycleLayout() {
        this.layouts.cycleLayout(this.driver.getCurrentContext());
    }
}