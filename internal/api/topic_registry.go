package api

import (
	"sync"
)

type topicRegistry struct {
	mu     sync.RWMutex
	topics map[string]map[*streamWSClient]struct{}
}

func newTopicRegistry() *topicRegistry {
	return &topicRegistry{
		topics: make(map[string]map[*streamWSClient]struct{}),
	}
}

func (r *topicRegistry) subscribe(client *streamWSClient, topic string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.topics[topic]; !ok {
		r.topics[topic] = make(map[*streamWSClient]struct{})
	}
	r.topics[topic][client] = struct{}{}
}

func (r *topicRegistry) unsubscribe(client *streamWSClient, topic string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if clients, ok := r.topics[topic]; ok {
		delete(clients, client)
		if len(clients) == 0 {
			delete(r.topics, topic)
		}
	}
}

func (r *topicRegistry) unsubscribeAll(client *streamWSClient) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var removed []string
	for topic, clients := range r.topics {
		if _, ok := clients[client]; ok {
			delete(clients, client)
			removed = append(removed, topic)
			if len(clients) == 0 {
				delete(r.topics, topic)
			}
		}
	}
	return removed
}

func (r *topicRegistry) broadcast(topic string, event any) {
	r.mu.RLock()
	clients := r.topics[topic]
	copies := make([]*streamWSClient, 0, len(clients))
	for c := range clients {
		copies = append(copies, c)
	}
	r.mu.RUnlock()

	for _, c := range copies {
		_ = c.writeJSON(event)
	}
}

func (r *topicRegistry) broadcastExcluding(topic string, exclude *streamWSClient, event any) {
	r.mu.RLock()
	clients := r.topics[topic]
	copies := make([]*streamWSClient, 0, len(clients))
	for c := range clients {
		if c != exclude {
			copies = append(copies, c)
		}
	}
	r.mu.RUnlock()

	for _, c := range copies {
		_ = c.writeJSON(event)
	}
}

func (r *topicRegistry) peers(topic string) []*streamWSClient {
	r.mu.RLock()
	defer r.mu.RUnlock()
	clients := r.topics[topic]
	result := make([]*streamWSClient, 0, len(clients))
	for c := range clients {
		result = append(result, c)
	}
	return result
}

func (r *topicRegistry) closeAll(topic string) {
	r.mu.RLock()
	clients := r.topics[topic]
	copies := make([]*streamWSClient, 0, len(clients))
	for c := range clients {
		copies = append(copies, c)
	}
	r.mu.RUnlock()

	for _, c := range copies {
		_ = c.close()
	}
}
