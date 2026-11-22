import { lstat } from "node:fs/promises";
import { userInfo } from "node:os";
import { writeResult } from "./output.js";
import {
  defaultSocket,
  type ProfileStore,
  type SupervisorTarget,
} from "./profiles.js";
import {
  directClient,
  discoverSupervisor,
  type DirectTargetMetadata,
} from "./supervisor-client.js";
import {
  connectSupervisor,
  localSocketError,
  LocalSocketPermissionError,
} from "./supervisor-transport.js";

export async function discoverLocalProfile(
  profiles: ProfileStore,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const name = "local";
  const registered = await profiles.find(name, signal);
  if (
    registered &&
    (registered.type !== "local" || registered.socket !== defaultSocket)
  )
    return undefined;
  const socket = await lstat(defaultSocket).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw localSocketError(error, defaultSocket);
    },
  );
  if (!socket?.isSocket()) return undefined;

  const target = { type: "local", socket: defaultSocket } as const;
  const transport = await connectSupervisor(target, signal);
  try {
    await discoverSupervisor(directClient(transport, signal), 3_000);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LocalSocketPermissionError) throw error;
    throw new Error(
      `Could not discover the local supervisor at ${defaultSocket}. Run 'borealis doctor' to check the service and socket.`,
      { cause: error },
    );
  } finally {
    await transport.close();
  }
  await profiles.add(name, target, signal);
  return await profiles.select(name, true, signal);
}

export async function identifySupervisorUser(
  name: string,
  profile: SupervisorTarget,
  json: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const transport = await connectSupervisor(profile, signal);
  try {
    const { hostId } = await discoverSupervisor(
      directClient(transport, signal),
    );
    const target: DirectTargetMetadata = {
      profile: name,
      type: profile.type,
      hostId,
      socket: profile.socket,
      ...(profile.type === "ssh" ? { alias: profile.alias } : {}),
    };
    const identity = profile.type === "local" ? userInfo() : undefined;
    const result = {
      profile: name,
      hostId,
      authentication: profile.type === "local" ? "unix-socket" : "ssh",
      ...(identity && {
        username: identity.username,
        uid: identity.uid,
        gid: identity.gid,
      }),
      ...(profile.type === "ssh" && { alias: profile.alias }),
    };
    const summary = identity
      ? `Local user ${identity.username} (UID ${identity.uid}) on host ${hostId} via profile '${name}'. Access uses OS permissions. No Cloud login required.`
      : `SSH profile '${name}' reaches host ${hostId}.`;
    writeResult(json ? { target, result } : summary, json);
  } finally {
    await transport.close();
  }
}
