import { runUploadStorageContract } from "../contract-tests/upload-storage.contract.js";
import { InMemoryUploadStorage } from "./in-memory-storage.js";

runUploadStorageContract({
  name: "InMemoryUploadStorage",
  factory: () => new InMemoryUploadStorage(),
});
