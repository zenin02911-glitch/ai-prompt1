import React, { useState, useEffect } from 'react';
import { 
  PartnerStore, 
  CatalogItem, 
  Order, 
  OrderItem, 
  BudgetItem, 
  OperationalMetrics 
} from './types';
import { 
  INITIAL_STORES, 
  INITIAL_CATALOG, 
  INITIAL_ORDERS, 
  BUDGET_LEDGER, 
  INITIAL_METRICS 
} from './data/mockData';
import { Header } from './components/Header';
import { StoreCounterView } from './components/StoreCounterView';
import { CatalogGuardView } from './components/CatalogGuardView';
import { DispatchOpsView } from './components/DispatchOpsView';
import { BusinessImpactView } from './components/BusinessImpactView';
import { GuidedDemoModal } from './components/GuidedDemoModal';
import { NewOrderModal } from './components/NewOrderModal';

export default function App() {
  const [activeTab, setActiveTab] = useState<'counter' | 'catalog' | 'dispatch' | 'economics'>('counter');
  const [stores, setStores] = useState<PartnerStore[]>(INITIAL_STORES);
  const [selectedStore, setSelectedStore] = useState<PartnerStore>(INITIAL_STORES[0]);
  const [catalog, setCatalog] = useState<CatalogItem[]>(INITIAL_CATALOG);
  const [orders, setOrders] = useState<Order[]>(INITIAL_ORDERS);
  const [activeOrderId, setActiveOrderId] = useState<string>(INITIAL_ORDERS[0].id);
  const [metrics, setMetrics] = useState<OperationalMetrics>(INITIAL_METRICS);
  const [budgetItems, setBudgetItems] = useState<BudgetItem[]>(BUDGET_LEDGER);
  
  const [isGuidedDemoOpen, setIsGuidedDemoOpen] = useState<boolean>(false);
  const [isNewOrderModalOpen, setIsNewOrderModalOpen] = useState<boolean>(false);

  // Active selected order object
  const activeOrder = orders.find(o => o.id === activeOrderId) || orders[0] || null;

  // Real-time ticking timer for active picking orders
  useEffect(() => {
    const timer = setInterval(() => {
      setOrders(prevOrders => 
        prevOrders.map(order => {
          if (order.status === 'PICKING' || order.status === 'ACTION_REQUIRED') {
            return {
              ...order,
              elapsedSeconds: order.elapsedSeconds + 1
            };
          }
          return order;
        })
      );
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // Handler: Update item status in order (FOUND vs MISSING)
  const handleUpdateItemStatus = (orderId: string, itemId: string, state: 'FOUND' | 'MISSING') => {
    setOrders(prevOrders => 
      prevOrders.map(order => {
        if (order.id !== orderId) return order;

        const updatedItems = order.items.map(item => {
          if (item.id !== itemId) return item;

          return {
            ...item,
            state,
            missingReason: state === 'MISSING' ? 'Flagged missing by counter staff' : undefined
          };
        });

        // Check if any item is missing and needs action
        const hasMissing = updatedItems.some(i => i.state === 'MISSING' && !i.substitutedWith);
        const newStatus = hasMissing ? 'ACTION_REQUIRED' : order.status === 'NEW' ? 'PICKING' : order.status;

        return {
          ...order,
          items: updatedItems,
          status: newStatus
        };
      })
    );

    // If an item is marked MISSING, auto-degrade catalog confidence and trigger auto-suppression
    if (state === 'MISSING') {
      const targetOrder = orders.find(o => o.id === orderId);
      const targetItem = targetOrder?.items.find(i => i.id === itemId);
      if (targetItem) {
        setCatalog(prevCatalog => 
          prevCatalog.map(cat => {
            if (cat.sku === targetItem.sku) {
              return {
                ...cat,
                stockCount: 0,
                confidenceScore: 18,
                status: 'SUPPRESSED_OOS',
                suppressionExpiresAt: '180 mins from now',
                suppressionReason: `Marked missing during live pick in Order #${targetOrder?.displayId}. Auto-suppressed to protect network fill-rate.`
              };
            }
            return cat;
          })
        );
      }
    }
  };

  // Handler: Direct in-store 1-tap substitution
  const handleApplySubstitution = (orderId: string, originalItemId: string, candidate: CatalogItem) => {
    setOrders(prevOrders => 
      prevOrders.map(order => {
        if (order.id !== orderId) return order;

        let priceDelta = 0;
        const updatedItems = order.items.map(item => {
          if (item.id !== originalItemId) return item;
          priceDelta = candidate.price - item.price;
          return {
            ...item,
            state: 'SUBSTITUTED' as const,
            substitutedWith: {
              sku: candidate.sku,
              name: candidate.name,
              price: candidate.price,
              unit: candidate.unit,
              priceDelta,
              approvedByCustomer: true // Staff-confirmed in-store parity
            }
          };
        });

        // Decrement candidate stock count in catalog
        setCatalog(prev => prev.map(c => c.sku === candidate.sku ? { ...c, stockCount: Math.max(0, c.stockCount - 1) } : c));

        // Check if all items are now resolved
        const allResolved = updatedItems.every(i => i.state === 'FOUND' || i.state === 'SUBSTITUTED');

        return {
          ...order,
          items: updatedItems,
          totalAmount: Math.max(0, order.totalAmount + priceDelta),
          status: allResolved ? 'PICKING' : order.status,
          customerNotification: undefined
        };
      })
    );
  };

  // Handler: Send 60s customer substitution approval ping
  const handleSendCustomerApproval = (orderId: string, originalItemId: string, candidate: CatalogItem) => {
    setOrders(prevOrders => 
      prevOrders.map(order => {
        if (order.id !== orderId) return order;

        const originalItem = order.items.find(i => i.id === originalItemId);
        if (!originalItem) return order;

        const delta = candidate.price - originalItem.price;
        const deltaText = delta === 0 ? 'same price' : delta < 0 ? `saving ₹${Math.abs(delta)}` : `+₹${delta}`;

        return {
          ...order,
          status: 'ACTION_REQUIRED',
          customerNotification: {
            type: 'SUBSTITUTION_REQUEST',
            message: `${originalItem.name} is unavailable. Suggested: ${candidate.name} (${candidate.unit}, ${deltaText}).`,
            timestamp: 'Just now',
            pendingApproval: true,
            targetItemSku: originalItem.sku,
            candidateItem: candidate
          }
        };
      })
    );
  };

  // Handler: Simulate customer tapping Accept or Decline on mobile push notification
  const handleSimulateCustomerDecision = (orderId: string, approved: boolean) => {
    setOrders(prevOrders => 
      prevOrders.map(order => {
        if (order.id !== orderId || !order.customerNotification) return order;

        const candidate = order.customerNotification.candidateItem;
        const targetSku = order.customerNotification.targetItemSku;

        if (approved && candidate && targetSku) {
          const delta = candidate.price - (order.items.find(i => i.sku === targetSku)?.price || candidate.price);

          const updatedItems = order.items.map(item => {
            if (item.sku !== targetSku) return item;
            return {
              ...item,
              state: 'SUBSTITUTED' as const,
              substitutedWith: {
                sku: candidate.sku,
                name: candidate.name,
                price: candidate.price,
                unit: candidate.unit,
                priceDelta: delta,
                approvedByCustomer: true
              }
            };
          });

          return {
            ...order,
            items: updatedItems,
            totalAmount: order.totalAmount + delta,
            status: 'PICKING',
            customerNotification: {
              type: 'SUBSTITUTION_ACCEPTED',
              message: `Customer approved substitution with ${candidate.name}!`,
              timestamp: 'Just now',
              pendingApproval: false
            }
          };
        } else {
          // If declined: item remains missing, buyer notified of single-item refund
          return {
            ...order,
            status: 'PICKING',
            customerNotification: undefined
          };
        }
      })
    );
  };

  // Handler: Seal Bag & Dispatch Rider
  const handleSealBagAndDispatch = (orderId: string) => {
    setOrders(prevOrders => 
      prevOrders.map(order => {
        if (order.id !== orderId) return order;

        return {
          ...order,
          status: 'PACKED',
          packedAt: 'Just now',
          rider: {
            ...order.rider,
            status: 'DISPATCHED',
            etaMins: 3
          }
        };
      })
    );
  };

  // Handler: Confirm Rider Handover at Counter
  const handleCompleteHandover = (orderId: string) => {
    setOrders(prevOrders => 
      prevOrders.map(order => {
        if (order.id !== orderId) return order;

        return {
          ...order,
          status: 'HANDED_OVER',
          handoverAt: 'Just now',
          rider: {
            ...order.rider,
            status: 'HANDOVER_COMPLETE',
            etaMins: 0,
            arrivedAt: 'Just now'
          }
        };
      })
    );

    // Update prototype simulation metrics: +1 order completed
    setMetrics(prev => ({
      ...prev,
      simulatedOrdersProcessed: prev.simulatedOrdersProcessed + 1,
      simulatedFillRate: Number(Math.min(99.0, prev.simulatedFillRate + 0.1).toFixed(1))
    }));
  };

  // Handler: Restock item in catalog
  const handleRestockItem = (sku: string, addedCount: number) => {
    setCatalog(prev => 
      prev.map(item => {
        if (item.sku !== sku) return item;
        return {
          ...item,
          stockCount: item.stockCount + addedCount,
          confidenceScore: 98,
          status: 'IN_STOCK',
          suppressionExpiresAt: undefined,
          suppressionReason: undefined
        };
      })
    );
  };

  // Handler: Manual force suppress item in catalog
  const handleSuppressItem = (sku: string, reason: string) => {
    setCatalog(prev => 
      prev.map(item => {
        if (item.sku !== sku) return item;
        return {
          ...item,
          confidenceScore: 24,
          status: 'SUPPRESSED_OOS',
          suppressionExpiresAt: '180 mins from now',
          suppressionReason: reason
        };
      })
    );
  };

  // Reset to initial demo state
  const handleResetDemoData = () => {
    setStores(INITIAL_STORES);
    setSelectedStore(INITIAL_STORES[0]);
    setCatalog(INITIAL_CATALOG);
    setOrders(INITIAL_ORDERS);
    setActiveOrderId(INITIAL_ORDERS[0].id);
    setMetrics(INITIAL_METRICS);
    setBudgetItems(BUDGET_LEDGER);
  };

  // Create & inject new order
  const handleCreateOrder = (newOrder: Order) => {
    setOrders(prev => [newOrder, ...prev]);
    setActiveOrderId(newOrder.id);
    setActiveTab('counter');
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans selection:bg-emerald-500/20 selection:text-emerald-300">
      
      {/* Header with Navigation and Active Store Context */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        stores={stores}
        selectedStore={selectedStore}
        onSelectStore={(s) => {
          setSelectedStore(s);
          const firstOrderForStore = orders.find(o => o.storeId === s.id);
          if (firstOrderForStore) setActiveOrderId(firstOrderForStore.id);
        }}
        onStartGuidedDemo={() => setIsGuidedDemoOpen(true)}
        onOpenNewOrderModal={() => setIsNewOrderModalOpen(true)}
        onResetDemoData={handleResetDemoData}
      />

      {/* Main View Area */}
      <main className="flex-1 pb-16">
        {activeTab === 'counter' && (
          <StoreCounterView
            orders={orders}
            activeOrder={activeOrder}
            catalog={catalog}
            onSelectOrder={(order) => setActiveOrderId(order.id)}
            onUpdateItemStatus={handleUpdateItemStatus}
            onApplySubstitution={handleApplySubstitution}
            onSendCustomerApproval={handleSendCustomerApproval}
            onSimulateCustomerDecision={handleSimulateCustomerDecision}
            onSealBagAndDispatch={handleSealBagAndDispatch}
            onCompleteHandover={handleCompleteHandover}
          />
        )}

        {activeTab === 'catalog' && (
          <CatalogGuardView
            catalog={catalog}
            storeName={selectedStore.name}
            onRestockItem={handleRestockItem}
            onSuppressItem={handleSuppressItem}
          />
        )}

        {activeTab === 'dispatch' && (
          <DispatchOpsView
            orders={orders}
            stores={stores}
            onCompleteHandover={handleCompleteHandover}
          />
        )}

        {activeTab === 'economics' && (
          <BusinessImpactView
            metrics={metrics}
            budgetItems={budgetItems}
          />
        )}
      </main>

      {/* Interactive Guided Demo Tour Modal */}
      <GuidedDemoModal
        isOpen={isGuidedDemoOpen}
        onClose={() => setIsGuidedDemoOpen(false)}
        onJumpToTab={(tab) => {
          setActiveTab(tab);
          if (tab === 'counter' && orders.length > 1) {
            setActiveOrderId(orders[1].id); // NC-8922 with missing item
          }
        }}
      />

      {/* Create Incoming Order Simulation Modal */}
      <NewOrderModal
        isOpen={isNewOrderModalOpen}
        onClose={() => setIsNewOrderModalOpen(false)}
        catalog={catalog}
        currentStore={selectedStore}
        onCreateOrder={handleCreateOrder}
      />

      {/* Quiet Footer adhering to anti-slop rules (no fake telemetry, no fake compiler status) */}
      <footer className="border-t border-neutral-900 bg-neutral-950 py-4 px-4 sm:px-6 text-xs text-neutral-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-400">NovaCart ShelfPulse</span>
            <span>·</span>
            <span>Partner-Store Fulfillment &amp; Catalog Guard</span>
            <span>·</span>
            <span className="font-mono text-neutral-400">Budget: ₹25 Lakh Six-Month Model</span>
          </div>
          <div className="text-[11px] text-neutral-500 font-mono">
            Zero Dark Stores · Zero Warehouse Construction · 100% Asset-Light
          </div>
        </div>
      </footer>

    </div>
  );
}
