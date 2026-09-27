// Reaction roles, role menus and the auto-role hand a role to whoever reacts
// or joins, so setting one up is the same as granting that role. Only let
// someone wire up a role they could hand out themselves: the server owner, a
// bot owner, or a member whose highest role sits above it. Without this a
// moderator with no role powers could attach Administrator to a reaction and
// claim it (or set it as the auto-role and join on an alt).
import { isBotOwner, isRealOwner } from '../handlers/staffSystem.js';
import { memberCanAssignRoleLive } from '../config/guildPermissions.js';

// Returns null when allowed, otherwise the message to show.
export async function roleGrantBlock(client, guildId, userId, roleId) {
  if (isBotOwner(userId) || await isRealOwner(guildId, userId)) return null;
  if (await memberCanAssignRoleLive(client, guildId, userId, roleId)) return null;
  return `You can only set up <@&${roleId}> if your own highest role is above it.`;
}
