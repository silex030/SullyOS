/**
 * shared · uiOperationLease (operation-lease-v2 唯一共享协议)
 *
 * 解决：async 写等待中 charId/storage 切换、A→B→A、卸载/重挂载后，
 * 迟到结果按槽位身份相等 (charId/storage ===) 被错误接纳。
 *
 * 三个单调量（同一 manager 内只增不减）：
 * - slotGeneration：每次已提交的 charId/storage 切换、卸载失效时 +1。
 *   A→B→A 的第二个 A 是新代次，不可能恢复 A1 旧租约。
 *   每个 manager 有全局唯一的 instanceId，新挂载（key 重挂载/StrictMode
 *   重复生命周期）实例不同，旧租约永不等于新实例。
 * - operationSequence：每次开始一个 async UI 操作 (collect/claim/recover/
 *   save) 时 +1 并被捕获。同槽的新操作使旧 UI 快照失效。
 * - editRevision：房间本地编辑（增/删/改/移动家具）时 +1 并被捕获。
 *   保存后发生的新本地编辑使旧 save 快照失效。
 *
 * 判定：
 * - isSlotCurrent：实例相同且 slot 代次相同（持久层归属粗粒度）。
 * - isOperationCurrent：实例+slot+op+edit 全相等（UI 接纳唯一条件）。
 *   所有迟到成功/失败/保护态只要不是 operation-current，一律不得更新
 *   当前槽 UI（stateRef/itemsRef/items、notice、状态、选择或“已保存”反馈）。
 *   持久层操作仍完成它捕获的原槽（不跨角色写），由调用方保证。
 *
 * 元数据确认栅栏（ordered-ack-closeout，替代旧 same-slot 无条件同步）：
 * - 同实例/同 slot 代次内，只接受操作序号单调递增的持久化确认来更新
 *   slotMeta（rev/status/raw）：已接纳较新 ack 后，更早 op 的旧 saved /
 *   conflict 确认一律丢弃，不得回退 rev。
 * - 尚未被新确认超越、仍属当前槽的已提交写 ack 可以接纳（维持 CAS 链不断），
 *   但不再有“同槽即同步”的无序例外。
 * - 角色/storage 切换或卸载使代次失效后，旧代次确认永不更新新槽。
 * - 确认成功必须同步对应 ref（下一次 save 的 expectedRev 立即可用），
 *   不能只等 React 下一次 render；元数据确认绝不等于允许陈旧结果改动
 *   items/选择/notice/onSaved。
 *
 * 奖励与 UI 分开：已落盘的 claim intent 按其自带的 charId+claimId 投递/
 * 幂等对账，不为忽略陈旧 UI 而静默丢奖，也不发给当前选中的其他角色。
 * 卸载后无回调可投递，靠盘 claimed+claimId 由集成者对账。
 *
 * Room 保存的 rev 指针说明：迟到 save 成功/冲突时，只允许有序栅栏
 * 接纳的确认静默同步 rev/raw 指针（为下一次保存提供正确的 expectedRev），
 * 绝不触碰 items、选择、notice 或 onSaved。这不是“接纳旧 UI 快照”，
 * 而是保持并发链不断；新旧布局覆盖判定只看 items 是否被旧快照改写。
 * 无序的同槽即同步已废除：同槽旧 ack 只有在其 op 超过已接纳确认时才可同步。
 */

let nextInstanceId = 1;

export interface UiOperationLease {
  /** manager 实例唯一号：重挂载/新实例永不复用。 */
  instance: number;
  /** 槽位代次：charId/storage 切换、卸载失效时递增。 */
  slot: number;
  /** 操作序号：每次 beginOperation 递增。 */
  op: number;
  /** 本地编辑版本：每次 notifyLocalEdit 递增。 */
  edit: number;
}

export class UiOperationLeaseManager {
  private readonly instanceId: number;
  private slotGen = 0;
  private opSeq = 0;
  private editRev = 0;
  /**
   * 已接纳持久化确认（ordered-ack-closeout 栅栏）：
   * 同实例/同 slot 代次内最后一次被接纳进 slotMeta 的操作租约。
   * 所有 save/conflict/recover 的 rev/status/raw 更新统一受它控制，
   * op 更早的旧确认一律丢弃，不得回退。
   */
  private acceptedAck: UiOperationLease | null = null;

  constructor() {
    this.instanceId = nextInstanceId;
    nextInstanceId += 1;
  }

  /** 已提交的槽位切换（charId/storage 变化）：旧租约全部失效。 */
  rotateSlot(): void {
    this.slotGen += 1;
    this.acceptedAck = null;
  }

  /** 卸载/失效：同 rotateSlot，使所有未完成租约失效。 */
  invalidateForUnmount(): void {
    this.slotGen += 1;
    this.acceptedAck = null;
  }

  /** 开始一个 async UI 操作：递增操作序号并捕获当前三元组。 */
  beginOperation(): UiOperationLease {
    this.opSeq += 1;
    return {
      instance: this.instanceId,
      slot: this.slotGen,
      op: this.opSeq,
      edit: this.editRev,
    };
  }

  /** 本地编辑（房间家具增删改移）：使已发出的旧 save 快照失效。 */
  notifyLocalEdit(): void {
    this.editRev += 1;
  }

  /** 粗粒度槽位归属：实例与 slot 代次相同。 */
  isSlotCurrent(lease: UiOperationLease): boolean {
    return lease.instance === this.instanceId && lease.slot === this.slotGen;
  }

  /**
   * UI 接纳唯一条件：实例+slot+op+edit 全相等。
   * - 跨槽/卸载/重挂载：slot 或 instance 不等 → false。
   * - 同槽新操作：op 不是最新 → false。
   * - 保存后新本地编辑：edit 不等 → false。
   */
  isOperationCurrent(lease: UiOperationLease): boolean {
    return (
      lease.instance === this.instanceId &&
      lease.slot === this.slotGen &&
      lease.op === this.opSeq &&
      lease.edit === this.editRev
    );
  }

  /**
   * 元数据确认栅栏：同实例/同 slot 代次内，只有操作序号严格超过
   * 已接纳确认的 ack 才允许更新 slotMeta（rev/status/raw）。
   * - 跨实例/跨代次（切换/卸载后旧确认）→ false，永不更新新槽。
   * - 同槽旧 ack（op <= 已接纳）→ false，不得回退 rev。
   * - 尚未被超越的当前槽已提交写 ack → true，接纳并推进已接纳指针。
   * 调用方接纳后必须同步对应 ref；本方法只做顺序判定，不碰 UI。
   */
  tryAcceptPersistenceAck(lease: UiOperationLease): boolean {
    if (lease.instance !== this.instanceId || lease.slot !== this.slotGen) return false;
    const prev = this.acceptedAck;
    if (
      prev !== null &&
      prev.instance === lease.instance &&
      prev.slot === lease.slot &&
      lease.op <= prev.op
    ) {
      return false;
    }
    this.acceptedAck = { ...lease };
    return true;
  }
}
