function createKernelRuntimeBridge({
  kernelConversationStore,
  createRuntime,
} = {}) {
  let kernelRuntimePromise = null

  async function resetKernelRuntime(reason = 'desktop_runtime_reset') {
    const current = kernelRuntimePromise
    kernelRuntimePromise = null
    kernelConversationStore?.clear?.()
    if (!current) return
    try {
      const runtime = await current
      await runtime.dispose(reason).catch(() => {})
    } catch {}
  }

  async function getKernelRuntime() {
    if (kernelRuntimePromise) return kernelRuntimePromise
    kernelRuntimePromise = Promise.resolve().then(() => createRuntime())
    try {
      return await kernelRuntimePromise
    } catch (error) {
      kernelRuntimePromise = null
      kernelConversationStore?.clear?.()
      throw error
    }
  }

  async function getKernelConversation({
    conversation,
    runtime,
    createConversation,
  } = {}) {
    return kernelConversationStore.getOrCreateConversation({
      conversation,
      createConversation: async () => createConversation({
        runtime: runtime || await getKernelRuntime(),
      }),
    })
  }

  return {
    getKernelConversation,
    getKernelRuntime,
    resetKernelRuntime,
  }
}

module.exports = {
  createKernelRuntimeBridge,
}
