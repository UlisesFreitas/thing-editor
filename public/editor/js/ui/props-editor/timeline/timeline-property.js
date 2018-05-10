import Timeline from './timeline.js';
import Window from '../../window.js';

export default class TimelineProperty extends React.Component {
	
	constructor(props) {
		super(props);
		this.state = {toggled:editor.settings.getItem('timeline-showed')};
		this.onToggleClick = this.onToggleClick.bind(this);
	}
	
	onToggleClick() {
		var t = !this.state.toggled
		this.setState({toggled: t});
		editor.settings.setItem('timeline-showed', t);
	}
	
	render () {
		var btn = R.btn(this.state.toggled ? 'Close Timeline' : 'Open timeline', this.onToggleClick);
		var timeline;
		if(this.state.toggled) {
			timeline = editor.ui.renderWindow('timeline', 'Timeline', React.createElement(Timeline, {onCloseClick:this.onToggleClick}), 1000, 1000, 400, 150, 400, 150);
			setTimeout(() => {
				Window.bringWindowForward($('#window-timeline'));
			}, 1);
		}
		return R.fragment(btn, timeline);
	}
}

