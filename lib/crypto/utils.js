import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';

export function md5(string) {
	return createHash('md5').update(string, 'utf-8').digest('hex');
}

// See AuthenticationMD5Password at https://www.postgresql.org/docs/current/static/protocol-flow.html
export function postgresMd5PasswordHash(user, password, salt) {
	const inner = md5(password + user);
	const outer = md5(Buffer.concat([Buffer.from(inner), salt]));

	return `md5${outer}`;
}

export function sha256(text) {
	return createHash('sha256').update(text).digest();
}

export function hmacSha256(key, msg) {
	return createHmac('sha256', key).update(msg).digest();
}

export async function deriveKey(password, salt, iterations) {
	return pbkdf2Sync(password, salt, iterations, 32, 'sha256');
}
