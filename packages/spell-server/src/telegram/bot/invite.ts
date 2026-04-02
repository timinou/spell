import { InputFile } from "grammy";
import QRCode from "qrcode";
import type { AuthContext } from "./auth";
import type { TokenStore } from "./tokens";

export function generateInviteLink(botUsername: string, token: string): string {
	return `https://t.me/${botUsername}?start=${token}`;
}

export async function generateQrBuffer(link: string): Promise<Buffer> {
	return QRCode.toBuffer(link, { type: "png", errorCorrectionLevel: "M" });
}

export async function handleInviteCommand(
	ctx: AuthContext,
	tokenStore: TokenStore,
	botUsername: string,
): Promise<void> {
	if (ctx.chat?.type !== "private") {
		await ctx.reply("Invite links can only be generated in private chats.");
		return;
	}

	const tempToken = tokenStore.generate();
	await tokenStore.save();

	const inviteLink = generateInviteLink(botUsername, tempToken.token);
	const qrBuffer = await generateQrBuffer(inviteLink);

	await ctx.replyWithPhoto(new InputFile(qrBuffer, "invite.png"), {
		caption: `Share this link to grant temporary access:\n${inviteLink}`,
	});
}
