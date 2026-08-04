import type { Component } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	/**
	 * The one rendered array, shared across frames: parent wrappers validate
	 * their own caches by child line-array identity, and a fresh array per
	 * call would defeat every one of those checks up the tree. The array is
	 * treated as read-only by all consumers, as every rendered line array is.
	 */
	private cached: string[] | undefined;

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		this.lines = lines;
		this.cached = undefined;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	render(_width: number): string[] {
		if (this.cached === undefined || this.cached.length !== this.lines) {
			this.cached = new Array<string>(this.lines).fill("");
		}
		return this.cached;
	}
}
