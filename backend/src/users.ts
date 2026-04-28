export interface User {
  username: string;
  createdAt: number;
}

const users = new Map<string, User>();

export function findOrCreateUser(username: string): User {
  const trimmed = username.trim();
  if (!trimmed) throw new Error("Username is required");

  let user = users.get(trimmed);
  if (!user) {
    user = {
      username: trimmed,
      createdAt: Date.now(),
    };
    users.set(trimmed, user);
  }
  return user;
}

export function getUser(username: string): User | undefined {
  return users.get(username.trim());
}
