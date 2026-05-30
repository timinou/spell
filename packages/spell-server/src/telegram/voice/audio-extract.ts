import { logger } from "@spell/pi-utils";

export function isFfmpegAvailable(): boolean {
	return Bun.which("ffmpeg") !== null;
}

export async function extractAudioFromVideo(videoBytes: Buffer): Promise<Buffer> {
	if (!isFfmpegAvailable()) {
		throw new Error("ffmpeg is not installed. Video note transcription requires ffmpeg.");
	}

	const proc = Bun.spawn(["ffmpeg", "-i", "pipe:0", "-vn", "-acodec", "libopus", "-f", "ogg", "pipe:1"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	proc.stdin.write(videoBytes);
	proc.stdin.end();

	const chunks: Uint8Array[] = [];
	const reader = proc.stdout.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
	}

	const stderrText = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		logger.warn("ffmpeg failed extracting Telegram video note audio", { exitCode, stderr: stderrText.trim() });
		throw new Error(`ffmpeg exited with code ${exitCode}`);
	}

	return Buffer.concat(chunks);
}
