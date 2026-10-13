package privacy

import (
	"container/list"
	"context"
	"sync"
)

type conversationKey struct{}

// WithConversation names the conversation a request belongs to, so an IPv4
// stand-in stays with its value for every turn of it.
func WithConversation(ctx context.Context, id string) context.Context {
	if id == "" {
		return ctx
	}
	return context.WithValue(ctx, conversationKey{}, id)
}

func conversationFrom(ctx context.Context) string {
	id, _ := ctx.Value(conversationKey{}).(string)
	return id
}

// maxLedgerConversations bounds the memory. A conversation evicted from it
// keeps working; its IPv4 stand-ins only lose the guarantee below.
const maxLedgerConversations = 1024

// standInLedgers remember, per conversation, which value each IPv4 stand-in was
// issued to. That pool is too small for a stand-in to identify its value: an
// address the request already holds may be this value's stand-in quoted back
// from unrestored reasoning, another value's, or documentation text. Values are
// recorded by keyed fingerprint, never in plain text, and the memory lives no
// longer than the derivation key the fingerprints depend on.
type standInLedgers struct {
	mutex  sync.Mutex
	byID   map[string]*list.Element
	recent list.List
}

func (ledgers *standInLedgers) conversation(id string) *standInLedger {
	if id == "" {
		return nil
	}
	ledgers.mutex.Lock()
	defer ledgers.mutex.Unlock()
	if element, exists := ledgers.byID[id]; exists {
		ledgers.recent.MoveToFront(element)
		return element.Value.(*standInLedger)
	}
	if ledgers.byID == nil {
		ledgers.byID = make(map[string]*list.Element)
	}
	ledger := &standInLedger{
		id:        id,
		byOwner:   make(map[string]string),
		byStandIn: make(map[string]string),
	}
	ledgers.byID[id] = ledgers.recent.PushFront(ledger)
	if ledgers.recent.Len() > maxLedgerConversations {
		oldest := ledgers.recent.Back()
		ledgers.recent.Remove(oldest)
		delete(ledgers.byID, oldest.Value.(*standInLedger).id)
	}
	return ledger
}

// standInLedger is one conversation's record. A stand-in once issued is never
// released to another value, because the history may still quote it.
type standInLedger struct {
	id        string
	mutex     sync.Mutex
	byOwner   map[string]string
	byStandIn map[string]string
}

// standInOf returns the stand-in the value was last issued.
func (ledger *standInLedger) standInOf(owner string) (string, bool) {
	ledger.mutex.Lock()
	defer ledger.mutex.Unlock()
	standIn, exists := ledger.byOwner[owner]
	return standIn, exists
}

// claim issues a stand-in to the value. One already issued to it is always
// granted, wherever the request quotes it; one issued to another value never
// is; an unissued one is refused when the request already holds it, since that
// occurrence is text this conversation never produced.
func (ledger *standInLedger) claim(standIn, owner string, held func() bool) bool {
	ledger.mutex.Lock()
	defer ledger.mutex.Unlock()
	switch ledger.byStandIn[standIn] {
	case owner:
	case "":
		if held() {
			return false
		}
		ledger.byStandIn[standIn] = owner
	default:
		return false
	}
	ledger.byOwner[owner] = standIn
	return true
}
