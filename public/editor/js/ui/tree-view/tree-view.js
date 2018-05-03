import TreeNode from './tree-node.js';
import Window from '../window.js';

var classViewProps = {className: 'vertical-layout'};
var leftPanelProps = {className: 'left-panel'};

R.renderSceneNode = (node) => {
	return React.createElement(TreeNode, {node: node, key: __getNodeExtendData(node).id});
}

function onEmptyClick() {
	editor.selection.clearSelection(true);
}

class TreeView extends React.Component {
	
	constructor (props) {
		super(props);
		this.selectInTree = this.selectInTree.bind(this);
		this.onCopyClick = this.onCopyClick.bind(this);
		this.onDeleteClick = this.onDeleteClick.bind(this);
		this.onBringUpClick = this.onBringUpClick.bind(this);
		this.onMoveUpClick = this.onMoveUpClick.bind(this);
		this.onMoveDownClick = this.onMoveDownClick.bind(this);
		this.onBringDownClick = this.onBringDownClick.bind(this);
	}
	
	selectInTree(node) {
		assert(node, "Attempt to select in tree emty node");
		var n = node;
		while (n && n.parent) {
			__getNodeExtendData(n).toggled = true;
			n = n.parent;
		}
		editor.selection.select(node);
		setTimeout(() => {
			var e = $('.scene-tree-view .item-selected');
			if (e[0]) {
				Window.bringWindowForward(e.closest('.window-body'));
				e[0].scrollIntoView({});
			}
		}, 1);
	}
	
	onDeleteClick() {
		if((editor.selection.length > 0) && (editor.selection[0] !== game.currentContainer)) {
			var p = editor.selection[0].parent;
			var i = p.getChildIndex(editor.selection[0]);
			
			editor.selection.some((o) => {
				o.remove();
			});
			
			editor.clearSelection();
			if(i > 0) {
				this.selectInTree(p.getChildAt(i - 1));
			} else if (p !== game.stage) {
				this.selectInTree(p);
			}
			editor.refreshTreeViewAndPropertyEditor();
			editor.sceneModified(true);
		}
	}
	
	onCopyClick() {
		if(editor.selection.length > 0) {
			editor.clipboardData = editor.selection.map(Lib.__serializeObject);
		}
	}
	
	onCutClick() {
		this.onCopyClick();
		this.onDeleteClick();
	}
	
	onPasteClick() {
		if(editor.clipboardData && editor.clipboardData.length > 0) {
			editor.selection.clearSelection();
			editor.clipboardData.some((data) => {
				var o = Lib._deserializeObject(data);
				editor.addToSelected(o);
				editor.selection.add(o);
			});
			editor.refreshTreeViewAndPropertyEditor();
			editor.sceneModified(true);
		}
	}
	
	onBringUpClick() {
		var i = 0;
		while(this.onMoveUpClick(true) && i++ < 100000);
		editor.sceneModified(true);
	}
	
	onMoveUpClick(dontSaveHistoryState) {
		var ret = false;
		
		editor.selection.some((o) => {
			if(o.parent !== game.stage) {
				var i = o.parent.getChildIndex(o);
				if (i > 1) {
					var upper = o.parent.getChildAt(i - 1);
					if (editor.selection.indexOf(upper) < 0) {
						o.parent.swapChildren(o, upper);
						ret = true;
					}
				}
			}
		});
		if(dontSaveHistoryState !== true) {
			editor.sceneModified(true);
		}
		return ret;
	}
	
	onMoveDownClick(dontSaveHistoryState) {
		var ret = false;
		
		editor.selection.some((o) => {
			if(o.parent !== game.stage) {
				var i = o.parent.getChildIndex(o);
				if(i < (o.parent.children.length - 1)) {
					var lower = o.parent.getChildAt(i + 1);
					if(editor.selection.indexOf(lower) < 0) {
						o.parent.swapChildren(o, lower);
						ret = true;
					}
				}
			}
		});
		if(dontSaveHistoryState !== true) {
			editor.sceneModified(true);
		}
		return ret;
	}
	
	onBringDownClick() {
		var i = 0;
		while(this.onMoveDownClick(true) && i++ < 100000);
		editor.sceneModified(true);
	}
	
	render() {
		if (!editor.game) return R.spinner();
		
		var isEmpty = editor.selection.length === 0;
		
		return R.div(classViewProps,
			R.div(leftPanelProps,
				R.btn(R.icon('delete'), this.onDeleteClick, 'Remove selected', undefined, 46, isEmpty),
				R.btn(R.icon('bring-up'), this.onBringUpClick, 'Bring selected up', undefined, undefined, isEmpty),
				R.btn(R.icon('move-up'), this.onMoveUpClick, 'Move selected up', undefined, undefined, isEmpty),
				R.btn(R.icon('move-down'), this.onMoveDownClick, 'Move selected down', undefined, undefined, isEmpty),
				R.btn(R.icon('bring-down'), this.onBringDownClick, 'Bring selected down', undefined, undefined, isEmpty),
				R.btn(R.icon('copy'), this.onCopyClick, 'Copy selected in to clipboard (Ctrl+C)', undefined, 1067, isEmpty),
				R.btn(R.icon('cut'), this.onCutClick, 'Cut selected (Ctrl+X)', undefined, 1088, isEmpty),
				R.btn(R.icon('paste'), this.onPasteClick, 'Paste (Ctrl+V)', undefined, 1086, editor.clipboardData != null)
			),
			R.div({className: 'scene-tree-view', onClick: onEmptyClick},
				editor.game.stage.children.map(renderRoots)
			)
		);
	}
}

const renderRoots = (node, i) => {
	if(node === game.currentContainer) {
		return R.renderSceneNode(node);
	} else {
		var style;
		if(__getNodeExtendData(node).hidden) {
			style = {display:'none'};
		}
		return R.div({className:'inactive-scene-item', style, key:'na-' + i, title:'This scene node is blocked by modal object for now.'}, R.classIcon(node.constructor), R.b(null, node.name), ' (' + node.constructor.name + ')');
	}
}

export default TreeView;